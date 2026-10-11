import { z } from "zod";
import { Prisma } from "@prisma/client";
import { onlinePaymentsEnabled } from "../../config/env";
import { logger } from "../../config/logger";
import { prisma, withTransaction } from "../../database/prisma";
import { AppError, badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { sha256 } from "../../common/utils/crypto";
import { formatInr } from "../../common/utils/money";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { paymentGateway, type GatewayPayment } from "../../integrations/razorpay";
import { audit, systemContext, type AuditContext } from "../audit/audit.service";
import { queueLowStockCheck } from "../inventory/inventory.service";
import { consumeReservations, releaseReservations } from "../inventory/reservations";
import { createNotification, dispatchNotifications } from "../notifications/notifications.service";
import { changeStatus, lockOrder } from "../orders/orders.service";
import { getSetting } from "../settings/settings.service";
import { applyRefundWebhook } from "../refunds/refunds.service";

export interface PaymentActor {
  userId: string;
  /** Staff with pos.use / orders permissions may pay on behalf of a customer (POS). */
  isStaffAllowed: boolean;
}

function assertAccess(order: { userId: string | null; channel: string }, actor: PaymentActor) {
  if (actor.isStaffAllowed) return;
  if (order.userId !== actor.userId) throw notFound("Order");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPaymentForOrder(orderId: string, actor: PaymentActor) {
  const gateway = paymentGateway();
  const store = await getSetting("store");
  return withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertAccess(order, actor);
    if (order.paymentStatus === "PAID") throw invalidState("This order is already paid");
    if (order.status !== "PENDING") throw invalidState(`This order is ${order.status.toLowerCase()} and cannot be paid`);
    if (order.reservationExpiresAt && order.reservationExpiresAt <= new Date()) {
      throw new AppError(409, "ORDER_EXPIRED", "This order has expired. Please place it again.");
    }

    // Re-use an open gateway order for the same amount (double clicks, page reloads).
    let payment = await tx.payment.findFirst({
      where: { orderId, provider: "RAZORPAY", status: { in: ["CREATED", "PENDING"] }, amount: order.grandTotal, razorpayOrderId: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) {
      const gwOrder = await gateway.createOrder({
        amount: order.grandTotal,
        currency: order.currency,
        receipt: order.orderNumber,
        notes: { orderId: order.id, orderNumber: order.orderNumber },
      });
      payment = await tx.payment.create({
        data: { orderId, provider: "RAZORPAY", status: "CREATED", amount: order.grandTotal, currency: order.currency, razorpayOrderId: gwOrder.id },
      });
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "PENDING" } });
    }
    return {
      provider: gateway.name,
      keyId: gateway.keyId,
      razorpayOrderId: payment.razorpayOrderId!,
      amount: payment.amount,
      currency: payment.currency,
      orderId: order.id,
      orderNumber: order.orderNumber,
      storeName: store.displayName,
      prefill: { name: order.customerName ?? "", email: order.customerEmail ?? "", contact: order.customerPhone ?? "" },
      expiresAt: order.reservationExpiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Verify (browser callback)
// ---------------------------------------------------------------------------

export const verifySchema = z.object({
  razorpay_order_id: z.string().min(5).max(100),
  razorpay_payment_id: z.string().min(5).max(100),
  razorpay_signature: z.string().min(10).max(200),
});

export async function verifyCheckout(input: z.infer<typeof verifySchema>, actor: PaymentActor) {
  const gateway = paymentGateway();
  const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: input.razorpay_order_id }, include: { order: true } });
  if (!payment) throw notFound("Payment");
  assertAccess(payment.order, actor);

  // 1. Signature proves the callback came from Razorpay for this order.
  const signatureOk = gateway.verifyPaymentSignature({ orderId: input.razorpay_order_id, paymentId: input.razorpay_payment_id, signature: input.razorpay_signature });
  if (!signatureOk) {
    logger.warn({ paymentId: payment.id, razorpayOrderId: input.razorpay_order_id }, "payment signature mismatch");
    await audit(prisma, { userId: actor.userId, ipAddress: null, userAgent: null }, { action: "payment.signature_invalid", entityType: "payment", entityId: payment.id, newValue: { razorpay_payment_id: input.razorpay_payment_id } });
    throw new AppError(422, "PAYMENT_VERIFICATION_FAILED", "We could not verify this payment. If money was deducted it will be reconciled automatically.");
  }

  // 2. Never trust the browser for status or amount: ask Razorpay.
  let gp = await gateway.fetchPayment(input.razorpay_payment_id);
  if (gp.orderId !== input.razorpay_order_id) throw new AppError(422, "PAYMENT_VERIFICATION_FAILED", "Payment does not belong to this order");
  if (gp.status === "authorized") gp = await gateway.capturePayment(gp.id, payment.amount, payment.currency);
  if (gp.status === "failed") {
    await markPaymentFailed(payment.id, gp.errorDescription ?? "Payment failed");
    throw new AppError(422, "PAYMENT_FAILED", gp.errorDescription ?? "The payment failed. Please try again.");
  }
  if (gp.status !== "captured") throw new AppError(409, "PAYMENT_PENDING", "Payment is still being processed. We will confirm your order shortly.");

  await markOrderPaid(payment.id, gp, "verify");
  const order = await prisma.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { id: true, orderNumber: true, status: true, paymentStatus: true } });
  return order;
}

// ---------------------------------------------------------------------------
// The single, idempotent "money received" path
// ---------------------------------------------------------------------------

async function alertAdmins(title: string, message: string) {
  const { adminEmails } = await getSetting("notifications");
  const ids = [];
  for (const to of adminEmails) ids.push(await createNotification(prisma, { channel: "EMAIL", template: "admin.alert", to, data: { title, message } }));
  await dispatchNotifications(ids);
  logger.error({ title, message }, "admin alert");
}

/**
 * Marks a payment as PAID and confirms its order. Safe to call any number of
 * times from the browser callback, webhooks and reconciliation — only the
 * first call has an effect (payment row lock + status check + UNIQUE
 * razorpay_payment_id).
 */
export async function markOrderPaid(paymentDbId: string, gp: GatewayPayment, source: "verify" | "webhook" | "reconcile") {
  const outcome = await withTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentDbId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentDbId } });
    if (payment.status === "PAID" || payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") return { kind: "already" as const };
    if (gp.amount !== payment.amount || gp.currency !== payment.currency) {
      return { kind: "mismatch" as const, message: `Payment ${gp.id} amount ${gp.amount} ${gp.currency} does not match expected ${payment.amount} ${payment.currency}` };
    }

    const order = await lockOrder(tx, payment.orderId);
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "PAID", razorpayPaymentId: gp.id, method: gp.method, paidAt: new Date(), failureReason: null },
    });
    await audit(tx, systemContext, { action: "payment.paid", entityType: "payment", entityId: payment.id, newValue: { source, razorpayPaymentId: gp.id, amount: gp.amount } });

    if (order.paymentStatus === "PAID") {
      return { kind: "duplicate" as const, orderNumber: order.orderNumber, amount: gp.amount };
    }
    if (order.status === "CANCELLED") {
      await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "PAID", notes: `${order.notes ?? ""}\nPayment ${gp.id} received after cancellation — refund or reinstate.`.trim() } });
      return { kind: "late" as const, orderNumber: order.orderNumber, amount: gp.amount };
    }

    const consumed = await consumeReservations(tx, { orderId: order.id, orderNumber: order.orderNumber, userId: order.userId });
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "PAID", reservationExpiresAt: null } });
    await tx.couponRedemption.updateMany({ where: { orderId: order.id, status: "ACTIVE" }, data: { status: "CONFIRMED" } });
    if (order.couponId) await tx.coupon.update({ where: { id: order.couponId }, data: { usedCount: { increment: 1 } } });
    const ids = await changeStatus(tx, order.id, "CONFIRMED", { note: `Payment received (${source})`, event: { type: "confirmed" } });
    // In-store sales are handed over at the counter once paid.
    if (order.channel === "POS") await changeStatus(tx, order.id, "DELIVERED", { note: "Handed over at the counter", event: { type: "delivered" } });
    return { kind: "confirmed" as const, ids, orderId: order.id, variantIds: consumed.map((c) => c.variantId) };
  });

  switch (outcome.kind) {
    case "confirmed":
      await dispatchNotifications(outcome.ids);
      await enqueue(QUEUE_NAMES.invoices, "invoice.issue", { orderId: outcome.orderId }, { jobId: `invoice-${outcome.orderId}` });
      await queueLowStockCheck(outcome.variantIds);
      break;
    case "mismatch":
      await alertAdmins("Payment amount mismatch", outcome.message);
      throw new AppError(422, "PAYMENT_VERIFICATION_FAILED", "Payment amount does not match the order. Our team has been alerted.");
    case "duplicate":
      await alertAdmins("Duplicate payment received", `Order ${outcome.orderNumber} was paid twice (${formatInr(outcome.amount)}). Refund the extra payment.`);
      break;
    case "late":
      await alertAdmins("Payment received for a cancelled order", `Order ${outcome.orderNumber} received ${formatInr(outcome.amount)} after it was cancelled. Refund the customer or reinstate the order.`);
      break;
  }
  return outcome.kind;
}

export async function markPaymentFailed(paymentDbId: string, reason: string) {
  await withTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentDbId}::uuid FOR UPDATE`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentDbId } });
    if (payment.status !== "CREATED" && payment.status !== "PENDING") return;
    await tx.payment.update({ where: { id: paymentDbId }, data: { status: "FAILED", failureReason: reason.slice(0, 500) } });
    // The order stays PENDING (stock still reserved) so the customer can retry until it expires.
    const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { paymentStatus: true } });
    if (order.paymentStatus !== "PAID") await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: "FAILED" } });
  });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

interface RazorpayWebhook {
  event: string;
  payload: {
    payment?: { entity: { id: string; order_id: string | null; status: string; amount: number; currency: string; method?: string; error_description?: string | null } };
    refund?: { entity: { id: string; payment_id: string; amount: number; status: string } };
  };
}

/** Stores a verified webhook once and queues it; duplicates are acknowledged and ignored. */
export async function ingestWebhook(rawBody: Buffer | undefined, signature: string | undefined, eventIdHeader: string | undefined) {
  if (!rawBody || !signature) throw badRequest("Missing webhook signature");
  if (!paymentGateway().verifyWebhookSignature(rawBody, signature)) {
    logger.warn("rejected razorpay webhook with invalid signature");
    throw new AppError(400, "INVALID_SIGNATURE", "Invalid webhook signature");
  }
  const body = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhook;
  const eventId = eventIdHeader ?? sha256(rawBody.toString("utf8"));
  await prisma.webhookEvent.createMany({
    data: [{ provider: "RAZORPAY", eventId, eventType: body.event, payload: body as unknown as Prisma.InputJsonValue, signatureValid: true }],
    skipDuplicates: true,
  });
  const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "RAZORPAY", eventId } } });
  if (event.status === "RECEIVED" || event.status === "FAILED") {
    await enqueue(QUEUE_NAMES.webhooks, "razorpay.process", { webhookEventId: event.id }, { jobId: `whk-${event.id}-${event.attempts}` });
  }
  return { received: true, duplicate: event.status === "PROCESSED" || event.status === "IGNORED" };
}

export async function processWebhookEvent(webhookEventId: string) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED") return;
  const body = event.payload as unknown as RazorpayWebhook;
  try {
    let handled = false;
    const p = body.payload.payment?.entity;
    if (p && ["payment.captured", "payment.authorized", "order.paid"].includes(body.event) && p.order_id) {
      const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: p.order_id } });
      if (payment) {
        // Re-read from Razorpay rather than trusting the payload alone.
        let gp = await paymentGateway().fetchPayment(p.id);
        if (gp.status === "authorized") gp = await paymentGateway().capturePayment(gp.id, payment.amount, payment.currency);
        if (gp.status === "captured") await markOrderPaid(payment.id, gp, "webhook");
        handled = true;
      }
    } else if (p && body.event === "payment.failed" && p.order_id) {
      const payment = await prisma.payment.findUnique({ where: { razorpayOrderId: p.order_id } });
      if (payment) {
        await markPaymentFailed(payment.id, p.error_description ?? "Payment failed");
        handled = true;
      }
    } else if (body.payload.refund && body.event.startsWith("refund.")) {
      handled = await applyRefundWebhook(body.payload.refund.entity);
    }
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date(), attempts: { increment: 1 }, error: null },
    });
  } catch (err) {
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "FAILED", attempts: { increment: 1 }, error: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation & expiry
// ---------------------------------------------------------------------------

/** Asks the gateway about every open payment of an order and settles it. */
export async function reconcileOrderPayments(orderId: string): Promise<"paid" | "unpaid"> {
  const payments = await prisma.payment.findMany({ where: { orderId, provider: "RAZORPAY", status: { in: ["CREATED", "PENDING", "FAILED"] }, razorpayOrderId: { not: null } } });
  for (const payment of payments) {
    const gwPayments = await paymentGateway().fetchOrderPayments(payment.razorpayOrderId!);
    let captured = gwPayments.find((g) => g.status === "captured");
    const authorized = gwPayments.find((g) => g.status === "authorized");
    if (!captured && authorized) captured = await paymentGateway().capturePayment(authorized.id, payment.amount, payment.currency);
    if (captured) {
      await markOrderPaid(payment.id, captured, "reconcile");
      return "paid";
    }
  }
  return "unpaid";
}

export async function reconcilePayment(paymentId: string, ctx: AuditContext) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound("Payment");
  if (payment.provider !== "RAZORPAY") throw badRequest("Only gateway payments can be reconciled");
  const result = await reconcileOrderPayments(payment.orderId);
  await audit(prisma, ctx, { action: "payment.reconcile", entityType: "payment", entityId: paymentId, newValue: { result } });
  return { result, payment: await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }) };
}

/** Periodic: settle open payments that never got a callback or webhook. */
export async function reconcileOpenPayments() {
  // No gateway to ask.
  if (!onlinePaymentsEnabled) return { checked: 0, paid: 0 };
  const open = await prisma.payment.findMany({
    where: { provider: "RAZORPAY", status: { in: ["CREATED", "PENDING"] }, createdAt: { lt: new Date(Date.now() - 5 * 60_000), gt: new Date(Date.now() - 3 * 86_400_000) } },
    select: { orderId: true },
    distinct: ["orderId"],
    take: 100,
  });
  let paid = 0;
  for (const p of open) {
    try {
      if ((await reconcileOrderPayments(p.orderId)) === "paid") paid += 1;
    } catch (err) {
      logger.warn({ orderId: p.orderId, err: (err as Error).message }, "reconciliation failed");
    }
  }
  return { checked: open.length, paid };
}

/** Cancels unpaid orders whose stock hold has expired (after a last reconciliation). */
export async function expireUnpaidOrders() {
  // An order is only cancelled after the gateway has been asked one last time; with no gateway, none is.
  if (!onlinePaymentsEnabled) return { expired: 0 };
  const due = await prisma.order.findMany({
    where: { status: "PENDING", paymentStatus: { notIn: ["PAID"] }, reservationExpiresAt: { lt: new Date() } },
    select: { id: true },
    take: 100,
  });
  let expired = 0;
  for (const { id } of due) {
    try {
      if ((await reconcileOrderPayments(id)) === "paid") continue;
    } catch (err) {
      // If the gateway is unreachable, do not cancel — retry on the next run.
      logger.warn({ orderId: id, err: (err as Error).message }, "skipping expiry; gateway unreachable");
      continue;
    }
    await withTransaction(async (tx) => {
      const order = await lockOrder(tx, id);
      if (order.status !== "PENDING" || order.paymentStatus === "PAID") return;
      await releaseReservations(tx, { orderId: id, orderNumber: order.orderNumber, reason: "Payment window expired", expired: true });
      await tx.couponRedemption.updateMany({ where: { orderId: id, status: "ACTIVE" }, data: { status: "CANCELLED" } });
      await tx.payment.updateMany({ where: { orderId: id, status: { in: ["CREATED", "PENDING"] } }, data: { status: "FAILED", failureReason: "Payment window expired" } });
      // Abandoned checkouts are cancelled quietly (no customer email).
      await tx.order.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Payment not completed in time", paymentStatus: "FAILED" } });
      await tx.orderStatusHistory.create({ data: { orderId: id, fromStatus: "PENDING", toStatus: "CANCELLED", note: "Payment not completed in time" } });
    });
    expired += 1;
  }
  return { expired };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const paymentListQuery = z.object({
  status: z.enum(["CREATED", "PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]).optional(),
  provider: z.enum(["RAZORPAY", "CASH", "UPI_MANUAL", "CARD_MANUAL"]).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function listPayments(q: z.infer<typeof paymentListQuery>, page: Pagination) {
  const where: Prisma.PaymentWhereInput = {
    status: q.status,
    provider: q.provider,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    OR: q.q
      ? [{ razorpayOrderId: { contains: q.q } }, { razorpayPaymentId: { contains: q.q } }, { referenceNumber: { contains: q.q } }, { order: { orderNumber: { contains: q.q.toUpperCase() } } }]
      : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.payment.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page), include: { order: { select: { id: true, orderNumber: true, customerName: true, channel: true } } } }),
    prisma.payment.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export async function getPayment(id: string) {
  const p = await prisma.payment.findUnique({ where: { id }, include: { order: { select: { id: true, orderNumber: true, status: true, grandTotal: true } }, refunds: true } });
  if (!p) throw notFound("Payment");
  return p;
}

