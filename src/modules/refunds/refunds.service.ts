import { z } from "zod";
import { Prisma, type Refund } from "@prisma/client";
import { onlinePaymentsEnabled } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { nextFinancialYearNumber } from "../../database/sequences";
import { AppError, badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { paymentGateway, paymentsUnavailable } from "../../integrations/razorpay";
import type { GatewayRefund } from "../../integrations/razorpay/gateway.types";
import { audit, type AuditContext } from "../audit/audit.service";
import { issueCreditNoteForRefund } from "../invoices/invoices.service";
import { dispatchNotifications } from "../notifications/notifications.service";
import { changeStatus, lockOrder, TRANSITIONS } from "../orders/orders.service";
import { orderEventNotifications } from "../orders/order-events";
import { getSetting } from "../settings/settings.service";

export const refundSchema = z.object({
  orderId: z.uuid(),
  /** Paise. Omit to refund everything still refundable. */
  amount: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(500),
  returnRequestId: z.uuid().optional(),
});

const REFUNDABLE_STATUSES = ["PAID", "PARTIALLY_REFUNDED"] as const;
/** Refunds whose money is gone or committed. FAILED refunds paid nothing. */
const LIVE_REFUND_STATUSES = ["PENDING", "PROCESSING", "PROCESSED"] as const;
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
/** A gateway payment can only be refunded through the gateway: without one, no refund is recorded and no number is used. */
const gatewayNeeded = () => paymentsUnavailable("This payment was made through the payment gateway, which is not connected. It can be refunded once it is.");

/**
 * Refunds recorded but not yet confirmed by the gateway (PENDING). Their
 * amount is not in `payment.amountRefunded` yet, but is already spoken for.
 */
async function inFlightAmount(tx: Tx, paymentId: string, excludeRefundId?: string) {
  const r = await tx.refund.aggregate({ where: { paymentId, status: "PENDING", id: excludeRefundId ? { not: excludeRefundId } : undefined }, _sum: { amount: true } });
  return r._sum.amount ?? 0;
}

/** What the returned units are worth: their share of what the customer paid for each line. */
export async function returnValue(db: Tx | typeof prisma, returnRequestId: string) {
  const items = await db.returnItem.findMany({ where: { returnRequestId }, include: { orderItem: { select: { lineTotal: true, quantity: true } } } });
  return items.reduce((s, i) => s + Math.round((i.orderItem.lineTotal * i.quantity) / i.orderItem.quantity), 0);
}

/** Value of a return still open for refund (value minus refunds that paid or are paying out). */
export async function returnRemaining(db: Tx | typeof prisma, returnRequestId: string, excludeRefundId?: string) {
  const [value, refunded] = await Promise.all([
    returnValue(db, returnRequestId),
    db.refund.aggregate({ where: { returnRequestId, status: { in: [...LIVE_REFUND_STATUSES] }, id: excludeRefundId ? { not: excludeRefundId } : undefined }, _sum: { amount: true } }),
  ]);
  return Math.max(0, value - (refunded._sum.amount ?? 0));
}

/**
 * A return is REFUNDED while at least one of its refunds has paid out (or is
 * paying out), and goes back to RECEIVED if the gateway later fails them all.
 */
async function syncReturnStatus(tx: Tx, returnRequestId: string | null) {
  if (!returnRequestId) return;
  const rr = await tx.returnRequest.findUnique({ where: { id: returnRequestId }, select: { status: true } });
  if (!rr || (rr.status !== "RECEIVED" && rr.status !== "REFUNDED")) return;
  const paid = await tx.refund.count({ where: { returnRequestId, status: { in: ["PROCESSING", "PROCESSED"] } } });
  const next = paid > 0 ? "REFUNDED" : "RECEIVED";
  if (next !== rr.status) await tx.returnRequest.update({ where: { id: returnRequestId }, data: { status: next } });
}

/**
 * Applies a refund's effect on the payment and order totals. Called once when
 * the refund is initiated (PROCESSING/PROCESSED) and reversed if the gateway
 * later reports it FAILED.
 */
async function applyCounters(tx: Tx, refund: Refund, direction: 1 | -1): Promise<(string | null)[]> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
  const paymentRefunded = payment.amountRefunded + direction * refund.amount;
  await tx.payment.update({
    where: { id: payment.id },
    data: { amountRefunded: paymentRefunded, status: paymentRefunded <= 0 ? "PAID" : paymentRefunded >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED" },
  });
  const order = await lockOrder(tx, refund.orderId);
  const orderRefunded = order.amountRefunded + direction * refund.amount;
  await tx.order.update({
    where: { id: order.id },
    data: { amountRefunded: orderRefunded, paymentStatus: orderRefunded <= 0 ? "PAID" : orderRefunded >= order.grandTotal ? "REFUNDED" : "PARTIALLY_REFUNDED" },
  });
  await syncReturnStatus(tx, refund.returnRequestId);
  if (direction === 1) {
    await issueCreditNoteForRefund(tx, refund.id);
    // A fully refunded cancelled/returned order ends in REFUNDED.
    if (orderRefunded >= order.grandTotal && TRANSITIONS[order.status].includes("REFUNDED") && ["CANCELLED", "RETURNED"].includes(order.status)) {
      return changeStatus(tx, order.id, "REFUNDED", { note: `Refund ${refund.refundNumber}`, event: { type: "refunded", amount: refund.amount, refundNumber: refund.refundNumber } });
    }
    return orderEventNotifications(tx, order.id, { type: "refunded", amount: refund.amount, refundNumber: refund.refundNumber });
  }
  return [];
}

export async function createRefund(input: z.infer<typeof refundSchema>, ctx: AuditContext, idempotencyKey: string): Promise<Refund> {
  const existing = await prisma.refund.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  const { allowPartial } = await getSetting("refunds");

  // Step 1: validate and record the refund intent. The order row lock
  // serialises every refund of the order (and so of its returns).
  const step1 = await withTransaction(async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    const payments = await tx.payment.findMany({ where: { orderId: order.id, status: { in: [...REFUNDABLE_STATUSES] } }, orderBy: { amount: "desc" } });
    if (!payments.length) throw invalidState("This order has no captured payment to refund");
    const available = new Map<string, number>();
    for (const p of payments) available.set(p.id, p.amount - p.amountRefunded - (await inFlightAmount(tx, p.id)));
    const refundable = [...available.values()].reduce((s, v) => s + Math.max(0, v), 0);
    const amount = input.amount ?? refundable;
    if (amount <= 0 || refundable <= 0) throw invalidState("Nothing left to refund on this order");
    if (amount > refundable) throw badRequest(`At most ${rupees(refundable)} can be refunded on this order`);
    if (!allowPartial && amount !== refundable) throw badRequest("Partial refunds are disabled in settings");
    const payment = payments.find((p) => available.get(p.id)! >= amount);
    if (!payment) throw badRequest("This refund spans several payments; refund each payment separately");
    if (payment.provider === "RAZORPAY" && !onlinePaymentsEnabled) throw gatewayNeeded();
    if (input.returnRequestId) {
      const rr = await tx.returnRequest.findFirst({ where: { id: input.returnRequestId, orderId: order.id }, select: { id: true } });
      if (!rr) throw badRequest("Return request does not belong to this order");
      const remaining = await returnRemaining(tx, rr.id);
      if (remaining <= 0) throw invalidState("This return has already been refunded");
      if (amount > remaining) throw badRequest(`At most ${rupees(remaining)} can still be refunded for this return`);
    }

    const refund = await tx.refund.create({
      data: {
        refundNumber: await nextFinancialYearNumber(tx, "RF", { separator: "-" }),
        paymentId: payment.id,
        orderId: order.id,
        returnRequestId: input.returnRequestId ?? null,
        amount,
        reason: input.reason,
        status: payment.provider === "RAZORPAY" ? "PENDING" : "PROCESSED",
        processedAt: payment.provider === "RAZORPAY" ? null : new Date(),
        idempotencyKey,
        initiatedById: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "refund.create", entityType: "refund", entityId: refund.id, newValue: { orderId: order.id, amount, provider: payment.provider, reason: input.reason } });
    // Cash / manual UPI refunds are handed back at the counter: final immediately.
    const ids = payment.provider === "RAZORPAY" ? [] : await applyCounters(tx, refund, 1);
    return { refund, payment, ids };
  });
  await dispatchNotifications(step1.ids);
  if (step1.payment.provider !== "RAZORPAY") return step1.refund;

  // Step 2: call the gateway outside the transaction.
  return executeGatewayRefund(step1.refund.id);
}

/** Finds our refund at the gateway by the refundId we put in its notes. */
async function findGatewayRefund(razorpayPaymentId: string, refundId: string): Promise<GatewayRefund | null> {
  const all = await paymentGateway().listRefunds(razorpayPaymentId);
  return all.find((r) => r.notes.refundId === refundId && r.status !== "failed") ?? null;
}

/** Records a refund the gateway accepted and applies it to the payment and order. */
async function confirmGatewayRefund(refundId: string, gw: GatewayRefund) {
  const ids = await withTransaction(async (tx) => {
    const refund = await tx.refund.update({
      where: { id: refundId },
      data: { razorpayRefundId: gw.id, status: gw.status === "processed" ? "PROCESSED" : "PROCESSING", processedAt: gw.status === "processed" ? new Date() : null, failureReason: null },
    });
    return applyCounters(tx, refund, 1);
  });
  await dispatchNotifications(ids);
}

/**
 * Sends a PENDING refund to Razorpay. Only a gateway error marks it FAILED;
 * if the error was ambiguous (timeout) and the refund did reach Razorpay,
 * it is recorded as successful instead.
 */
async function executeGatewayRefund(refundId: string): Promise<Refund> {
  const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
  const paymentId = refund.payment.razorpayPaymentId!;
  let gw: GatewayRefund | null = null;
  let failure: string | null = null;
  try {
    gw = await paymentGateway().refund(paymentId, { amount: refund.amount, receipt: refund.refundNumber, notes: { orderId: refund.orderId, refundId: refund.id } });
  } catch (err) {
    failure = String((err as { error?: { description?: string } }).error?.description ?? (err as Error).message).slice(0, 500);
    gw = await findGatewayRefund(paymentId, refund.id).catch(() => null);
  }
  if (gw) {
    await confirmGatewayRefund(refund.id, gw);
  } else {
    await prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED", failureReason: failure } });
    logger.error({ refundId: refund.id, err: failure }, "gateway refund failed");
    throw new AppError(502, "REFUND_FAILED", `The payment gateway rejected the refund: ${failure}`);
  }
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

export function refundOrderInFull(orderId: string, reason: string, ctx: AuditContext, idempotencyKey: string) {
  return createRefund({ orderId, reason }, ctx, idempotencyKey);
}

/**
 * Retries a FAILED gateway refund on the same refund record (same number,
 * same audit trail). Re-checks the balances first, and if the earlier attempt
 * actually reached Razorpay, records that instead of refunding twice.
 */
export async function retryRefund(refundId: string, ctx: AuditContext): Promise<Refund> {
  const current = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!current) throw notFound("Refund");
  if (current.status !== "FAILED") throw invalidState("Only failed refunds can be retried");
  if (current.payment.provider !== "RAZORPAY" || !current.payment.razorpayPaymentId) throw invalidState("Only gateway refunds can be retried");
  if (!onlinePaymentsEnabled) throw gatewayNeeded();
  const earlier = await findGatewayRefund(current.payment.razorpayPaymentId, current.id);

  await withTransaction(async (tx) => {
    await lockOrder(tx, current.orderId);
    await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    if (refund.status !== "FAILED") throw invalidState("This refund is no longer in a failed state");
    if (!earlier) {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
      const available = payment.amount - payment.amountRefunded - (await inFlightAmount(tx, payment.id));
      if (refund.amount > available) throw invalidState(`Only ${rupees(Math.max(0, available))} is still refundable on this payment`);
      if (refund.returnRequestId && refund.amount > (await returnRemaining(tx, refund.returnRequestId, refund.id))) {
        throw invalidState("This return has since been refunded by another refund");
      }
      await tx.refund.update({ where: { id: refundId }, data: { status: "PENDING", failureReason: null } });
    }
    await audit(tx, ctx, { action: earlier ? "refund.recovered" : "refund.retry", entityType: "refund", entityId: refundId, newValue: { amount: refund.amount, gatewayRefundId: earlier?.id ?? null } });
  });

  if (earlier) {
    await confirmGatewayRefund(refundId, earlier);
    return prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }
  return executeGatewayRefund(refundId);
}

/** Webhook: refund.processed / refund.failed from Razorpay. */
export async function applyRefundWebhook(entity: { id: string; status: string }): Promise<boolean> {
  const refund = await prisma.refund.findUnique({ where: { razorpayRefundId: entity.id } });
  if (!refund) return false;
  const ids = await withTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refund.id}::uuid FOR UPDATE`;
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
    if (entity.status === "processed" && current.status !== "PROCESSED") {
      await tx.refund.update({ where: { id: refund.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    } else if (entity.status === "failed" && current.status !== "FAILED") {
      const failed = await tx.refund.update({ where: { id: refund.id }, data: { status: "FAILED", failureReason: "Reported failed by Razorpay" } });
      return applyCounters(tx, failed, -1);
    }
    return [];
  });
  await dispatchNotifications(ids);
  return true;
}

export async function listRefunds(q: { status?: "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED"; orderId?: string }, page: Pagination) {
  const where: Prisma.RefundWhereInput = { status: q.status, orderId: q.orderId };
  const [items, total] = await Promise.all([
    prisma.refund.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page), include: { order: { select: { id: true, orderNumber: true, customerName: true } }, payment: { select: { provider: true, method: true } } } }),
    prisma.refund.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export async function getRefund(id: string) {
  const r = await prisma.refund.findUnique({ where: { id }, include: { order: { select: { id: true, orderNumber: true } }, payment: true, creditNote: true } });
  if (!r) throw notFound("Refund");
  return r;
}
