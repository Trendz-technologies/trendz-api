import { z } from "zod";
import { Prisma, type ReturnStatus } from "@prisma/client";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { nextFinancialYearNumber } from "../../database/sequences";
import { AppError, badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { audit, type AuditContext } from "../audit/audit.service";
import { resolveCode } from "../codes/scan.service";
import { applyMovements, type Movement } from "../inventory/stock";
import { createNotification, dispatchNotifications } from "../notifications/notifications.service";
import { changeStatus, lockOrder } from "../orders/orders.service";
import { createRefund, returnRemaining, returnValue } from "../refunds/refunds.service";
import { getSetting } from "../settings/settings.service";

export const returnItemsSchema = z
  .array(z.object({ orderItemId: z.uuid(), quantity: z.number().int().positive(), reason: z.string().trim().max(300).optional() }))
  .min(1)
  .max(100);

export const customerReturnSchema = z.object({
  orderNumber: z.string().max(40),
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1000).optional(),
  items: returnItemsSchema,
});

export const staffReturnSchema = z.object({
  orderId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1000).optional(),
  items: returnItemsSchema,
  /** Counter returns can be approved on the spot. */
  approve: z.boolean().default(false),
});

export const receiveSchema = z.object({
  items: z
    .array(z.object({ returnItemId: z.uuid(), condition: z.enum(["GOOD", "DAMAGED", "DEFECTIVE"]), warehouseId: z.uuid().optional() }))
    .min(1),
  notes: z.string().trim().max(1000).optional(),
});

const include = {
  order: { select: { id: true, orderNumber: true, channel: true, customerName: true, customerEmail: true, customerPhone: true, grandTotal: true, amountRefunded: true, status: true } },
  items: { include: { orderItem: true, warehouse: { select: { id: true, code: true, name: true } } } },
  refunds: true,
} satisfies Prisma.ReturnRequestInclude;

/** Quantity of an order line already returned or in an open return request. */
async function committedQuantities(tx: Tx, orderId: string) {
  const rows = await tx.returnItem.findMany({
    where: { returnRequest: { orderId, status: { notIn: ["REJECTED", "CANCELLED"] } } },
    select: { orderItemId: true, quantity: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.orderItemId, (map.get(r.orderItemId) ?? 0) + r.quantity);
  return map;
}

async function createReturn(
  orderId: string,
  input: { reason: string; notes?: string; items: z.infer<typeof returnItemsSchema> },
  ctx: AuditContext,
  opts: { by: "customer" | "staff"; approve?: boolean },
) {
  const { windowDays } = await getSetting("returns");
  const result = await withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (opts.by === "customer") {
      if (order.status !== "DELIVERED" && order.status !== "RETURN_REQUESTED") throw invalidState("Returns can be requested after the order is delivered");
      const deadline = order.deliveredAt ? order.deliveredAt.getTime() + windowDays * 86_400_000 : 0;
      if (Date.now() > deadline) throw invalidState(`The ${windowDays}-day return window for this order has closed`);
    } else if (!["DELIVERED", "RETURN_REQUESTED", "RETURNED", "CONFIRMED"].includes(order.status)) {
      throw invalidState(`Orders that are ${order.status} cannot be returned`);
    }

    const orderItems = await tx.orderItem.findMany({ where: { orderId } });
    const committed = await committedQuantities(tx, orderId);
    for (const it of input.items) {
      const oi = orderItems.find((o) => o.id === it.orderItemId);
      if (!oi) throw badRequest("Item does not belong to this order");
      const remaining = oi.quantity - (committed.get(oi.id) ?? 0);
      if (it.quantity > remaining) throw badRequest(`${oi.sku}: at most ${remaining} unit(s) can be returned`);
      committed.set(oi.id, (committed.get(oi.id) ?? 0) + it.quantity);
    }

    const rr = await tx.returnRequest.create({
      data: {
        returnNumber: await nextFinancialYearNumber(tx, "RET", { separator: "-" }),
        orderId,
        userId: order.userId,
        status: opts.approve ? "APPROVED" : "REQUESTED",
        reason: input.reason,
        customerNotes: opts.by === "customer" ? (input.notes ?? null) : null,
        adminNotes: opts.by === "staff" ? (input.notes ?? null) : null,
        approvedAt: opts.approve ? new Date() : null,
        processedById: opts.by === "staff" ? ctx.userId : null,
        items: {
          create: input.items.map((it) => ({
            orderItemId: it.orderItemId,
            variantId: orderItems.find((o) => o.id === it.orderItemId)!.variantId,
            quantity: it.quantity,
            reason: it.reason ?? null,
          })),
        },
      },
    });
    const ids = order.status === "DELIVERED" ? await changeStatus(tx, orderId, "RETURN_REQUESTED", { note: `Return ${rr.returnNumber}`, userId: ctx.userId }) : [];
    await audit(tx, ctx, { action: "return.create", entityType: "return_request", entityId: rr.id, newValue: { orderId, items: input.items, by: opts.by } });
    return { rr, ids };
  });
  await dispatchNotifications(result.ids);
  return getReturn(result.rr.id);
}

export async function createCustomerReturn(userId: string, input: z.infer<typeof customerReturnSchema>, ctx: AuditContext) {
  const order = await prisma.order.findFirst({ where: { orderNumber: input.orderNumber, userId }, select: { id: true } });
  if (!order) throw notFound("Order");
  return createReturn(order.id, input, ctx, { by: "customer" });
}

export function createStaffReturn(input: z.infer<typeof staffReturnSchema>, ctx: AuditContext) {
  return createReturn(input.orderId, input, ctx, { by: "staff", approve: input.approve });
}

async function lockReturn(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM return_requests WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("Return");
  return tx.returnRequest.findUniqueOrThrow({ where: { id }, include: { items: { include: { orderItem: true } } } });
}

async function notifyCustomer(tx: Tx, rr: { id: string; returnNumber: string; userId: string | null }, title: string, body: string) {
  if (!rr.userId) return [];
  return [await createNotification(tx, { channel: "IN_APP", userId: rr.userId, title, body, link: `/account/returns/${rr.returnNumber}`, idempotencyKey: `return:${rr.id}:${title}` })];
}

export async function approveReturn(id: string, notes: string | undefined, ctx: AuditContext) {
  const ids = await withTransaction(async (tx) => {
    const rr = await lockReturn(tx, id);
    if (rr.status !== "REQUESTED") throw invalidState(`Return is ${rr.status}`);
    await tx.returnRequest.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), processedById: ctx.userId, adminNotes: notes ?? rr.adminNotes } });
    await audit(tx, ctx, { action: "return.approve", entityType: "return_request", entityId: id });
    return notifyCustomer(tx, rr, `Return ${rr.returnNumber} approved`, "Please hand the items to the courier or bring them to the store.");
  });
  await dispatchNotifications(ids);
  return getReturn(id);
}

export async function rejectReturn(id: string, notes: string, ctx: AuditContext) {
  const ids = await withTransaction(async (tx) => {
    const rr = await lockReturn(tx, id);
    if (rr.status !== "REQUESTED" && rr.status !== "APPROVED") throw invalidState(`Return is ${rr.status}`);
    await tx.returnRequest.update({ where: { id }, data: { status: "REJECTED", closedAt: new Date(), processedById: ctx.userId, adminNotes: notes } });
    // Back to DELIVERED if nothing else is being returned.
    const open = await tx.returnRequest.count({ where: { orderId: rr.orderId, status: { in: ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "RECEIVED"] } } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: rr.orderId } });
    const ids = !open && order.status === "RETURN_REQUESTED" ? await changeStatus(tx, rr.orderId, "DELIVERED", { note: `Return ${rr.returnNumber} rejected`, userId: ctx.userId }) : [];
    await audit(tx, ctx, { action: "return.reject", entityType: "return_request", entityId: id, newValue: { notes } });
    return [...ids, ...(await notifyCustomer(tx, rr, `Return ${rr.returnNumber} rejected`, notes))];
  });
  await dispatchNotifications(ids);
  return getReturn(id);
}

/**
 * Inspection on arrival. GOOD units go back to sellable stock (or to the
 * "returned" quarantine bucket if auto-restock is off); DAMAGED / DEFECTIVE
 * units go to the damaged bucket. Every unit is a RETURN ledger movement.
 */
export async function receiveReturn(id: string, input: z.infer<typeof receiveSchema>, ctx: AuditContext) {
  const { autoRestockGood } = await getSetting("returns");
  const ids = await withTransaction(async (tx) => {
    const rr = await lockReturn(tx, id);
    if (!["APPROVED", "PICKUP_SCHEDULED"].includes(rr.status)) throw invalidState(`Return is ${rr.status}; approve it before receiving`);
    if (input.items.length !== rr.items.length || !rr.items.every((i) => input.items.some((x) => x.returnItemId === i.id))) {
      throw badRequest("Inspect every item of the return");
    }
    const movements: Movement[] = [];
    for (const it of input.items) {
      const ri = rr.items.find((r) => r.id === it.returnItemId)!;
      const warehouseId = it.warehouseId ?? ri.orderItem.warehouseId;
      const bucket = it.condition === "GOOD" ? (autoRestockGood ? "ON_HAND" : "RETURNED") : "DAMAGED";
      movements.push({ variantId: ri.variantId, warehouseId, bucket, delta: ri.quantity, type: "RETURN" });
      await tx.returnItem.update({
        where: { id: ri.id },
        data: { condition: it.condition, warehouseId, restockedQuantity: bucket === "ON_HAND" ? ri.quantity : 0 },
      });
      await tx.orderItem.update({ where: { id: ri.orderItemId }, data: { returnedQuantity: { increment: ri.quantity } } });
    }
    const order = await lockOrder(tx, rr.orderId);
    await applyMovements(tx, movements, { referenceType: "RETURN", referenceId: rr.id, referenceNumber: `${rr.returnNumber} / ${order.orderNumber}`, userId: ctx.userId, notes: input.notes ?? "Return received" });
    await tx.returnRequest.update({ where: { id }, data: { status: "RECEIVED", receivedAt: new Date(), adminNotes: input.notes ?? rr.adminNotes } });
    const ids = ["RETURN_REQUESTED", "DELIVERED"].includes(order.status) ? await changeStatus(tx, rr.orderId, "RETURNED", { note: `Return ${rr.returnNumber} received`, userId: ctx.userId }) : [];
    await audit(tx, ctx, { action: "return.receive", entityType: "return_request", entityId: id, newValue: input });
    return [...ids, ...(await notifyCustomer(tx, rr, `Return ${rr.returnNumber} received`, "We have received your items. Your refund is being processed."))];
  });
  await dispatchNotifications(ids);
  return getReturn(id);
}

/** What can still be refunded for a return: the returned units' value minus refunds already paid or in progress. */
export async function returnRefundableAmount(id: string) {
  const rr = await prisma.returnRequest.findUnique({ where: { id }, select: { id: true } });
  if (!rr) throw notFound("Return");
  return returnRemaining(prisma, id);
}

/**
 * Refunds (part of) a received return. Each attempt gets its own idempotency
 * key, and createRefund re-checks the remaining amount under the order lock,
 * so a failed attempt can be followed by a new one but nothing is paid twice.
 * The return's status follows its refunds (see syncReturnStatus).
 */
export async function refundReturn(id: string, amount: number | undefined, ctx: AuditContext) {
  const rr = await prisma.returnRequest.findUnique({ where: { id } });
  if (!rr) throw notFound("Return");
  if (rr.status !== "RECEIVED" && rr.status !== "REFUNDED") throw invalidState("Receive and inspect the return before refunding");
  const remaining = await returnRemaining(prisma, id);
  if (remaining <= 0) throw invalidState("This return has already been refunded");
  const refundAmount = amount ?? remaining;
  if (refundAmount > remaining) throw badRequest(`At most ₹${(remaining / 100).toFixed(2)} can still be refunded for this return`);
  const attempt = await prisma.refund.count({ where: { returnRequestId: id } });
  const refund = await createRefund({ orderId: rr.orderId, amount: refundAmount, reason: `Return ${rr.returnNumber}: ${rr.reason}`, returnRequestId: id }, ctx, `return:${id}:${attempt}`);
  await withTransaction(async (tx) => {
    // Record each item's share of everything refunded for this return so far.
    const value = await returnValue(tx, id);
    const paid = await tx.refund.aggregate({ where: { returnRequestId: id, status: { in: ["PROCESSING", "PROCESSED"] } }, _sum: { amount: true } });
    const refunded = paid._sum.amount ?? 0;
    const items = await tx.returnItem.findMany({ where: { returnRequestId: id }, include: { orderItem: true } });
    for (const i of items) {
      const share = Math.round((refunded * i.orderItem.lineTotal * i.quantity) / i.orderItem.quantity / Math.max(1, value));
      await tx.returnItem.update({ where: { id: i.id }, data: { refundAmount: share } });
    }
    await audit(tx, ctx, { action: "return.refund", entityType: "return_request", entityId: id, newValue: { refundId: refund.id, amount: refundAmount, status: refund.status } });
  });
  return getReturn(id);
}

export async function closeReturn(id: string, ctx: AuditContext) {
  await withTransaction(async (tx) => {
    const rr = await lockReturn(tx, id);
    const closable: ReturnStatus[] = ["RECEIVED", "REFUNDED"];
    if (!closable.includes(rr.status)) throw invalidState(`Return is ${rr.status}`);
    await tx.returnRequest.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } });
    await audit(tx, ctx, { action: "return.close", entityType: "return_request", entityId: id });
  });
  return getReturn(id);
}

/**
 * Return desk scanning: identifies the SKU, then finds the order line it was
 * sold on (in the given order, or recent orders containing it).
 */
export async function scanForReturn(code: string, orderNumber?: string) {
  const { variantId } = await resolveCode(code);
  const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { id: true, sku: true, title: true, product: { select: { name: true } } } });
  const orders = await prisma.order.findMany({
    where: {
      ...(orderNumber ? { orderNumber: orderNumber.toUpperCase() } : { placedAt: { gte: new Date(Date.now() - 180 * 86_400_000) } }),
      status: { in: ["DELIVERED", "RETURN_REQUESTED", "RETURNED", "CONFIRMED"] },
      items: { some: { variantId } },
    },
    orderBy: { placedAt: "desc" },
    take: 10,
    select: { id: true, orderNumber: true, channel: true, customerName: true, customerPhone: true, placedAt: true, deliveredAt: true, status: true, items: { where: { variantId } } },
  });
  if (orderNumber && orders.length === 0) {
    throw new AppError(404, "NOT_IN_ORDER", `${variant.sku} was not sold on order ${orderNumber}`);
  }
  const { windowDays } = await getSetting("returns");
  const candidates = [];
  for (const o of orders) {
    const committed = await committedQuantities(prisma, o.id);
    for (const item of o.items) {
      const returnable = item.quantity - (committed.get(item.id) ?? 0);
      const deadline = o.deliveredAt ? new Date(o.deliveredAt.getTime() + windowDays * 86_400_000) : null;
      candidates.push({
        orderId: o.id,
        orderNumber: o.orderNumber,
        channel: o.channel,
        customerName: o.customerName,
        placedAt: o.placedAt,
        orderItemId: item.id,
        quantitySold: item.quantity,
        returnable,
        unitPaid: Math.round(item.lineTotal / item.quantity),
        withinWindow: !deadline || deadline > new Date(),
        eligible: returnable > 0,
      });
    }
  }
  return { variant: { id: variant.id, sku: variant.sku, title: variant.title, name: variant.product.name }, candidates };
}

export async function getReturn(id: string) {
  const rr = await prisma.returnRequest.findUnique({ where: { id }, include });
  if (!rr) throw notFound("Return");
  return rr;
}

export async function getCustomerReturn(userId: string, returnNumber: string) {
  const rr = await prisma.returnRequest.findFirst({ where: { returnNumber, userId }, include });
  if (!rr) throw notFound("Return");
  return rr;
}

export async function listReturns(q: { status?: ReturnStatus; userId?: string; orderId?: string }, page: Pagination) {
  const where: Prisma.ReturnRequestWhereInput = { status: q.status, userId: q.userId, orderId: q.orderId };
  const [items, total] = await Promise.all([
    prisma.returnRequest.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page), include: { order: { select: { orderNumber: true, customerName: true } }, items: { select: { quantity: true, condition: true } } } }),
    prisma.returnRequest.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}
