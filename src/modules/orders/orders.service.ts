import { z } from "zod";
import { Prisma, type Address, type OrderStatus, type SalesChannel } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { nextOrderNumber } from "../../database/sequences";
import { AppError, badRequest, forbidden, invalidState, notFound, unprocessable } from "../../common/errors/app-error";
import { allocate } from "../../common/utils/money";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { audit, type AuditContext } from "../audit/audit.service";
import { getOwnedAddress } from "../users/account.service";
import { availabilityByVariant, onlineWarehouses } from "../inventory/availability";
import { applyMovements, InsufficientStockError, lockLevels } from "../inventory/stock";
import { releaseReservations, reserveStock, type ReservationLine } from "../inventory/reservations";
import { dispatchNotifications } from "../notifications/notifications.service";
import { redemptionCounts } from "../promotions/coupons.service";
import { priceLines, type Quote } from "../pricing/pricing.service";
import { getSetting } from "../settings/settings.service";
import { cartWeightGrams, shippingRateFor } from "../shipping/shipping.service";
import { orderEventNotifications, type OrderEvent } from "./order-events";
// Circular imports are safe here: these are only called at request time.
import { reconcileOrderPayments } from "../payments/payments.service";
import { refundOrderInFull } from "../refunds/refunds.service";

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"],
  PROCESSING: ["PACKED", "SHIPPED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: ["RETURN_REQUESTED", "RETURNED", "REFUNDED"],
  RETURN_REQUESTED: ["RETURNED", "DELIVERED", "REFUNDED"],
  RETURNED: ["REFUNDED"],
  CANCELLED: ["REFUNDED"],
  REFUNDED: [],
};

/** Transitions staff may set by hand; the rest are driven by payments, shipments and returns. */
export const MANUAL_TRANSITIONS = new Set<OrderStatus>(["PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);

const SHIPPING_STATUS_FOR: Partial<Record<OrderStatus, Prisma.OrderUpdateInput["shippingStatus"]>> = {
  SHIPPED: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
};

const EVENT_FOR: Partial<Record<OrderStatus, OrderEvent["type"]>> = { SHIPPED: "shipped", OUT_FOR_DELIVERY: "out_for_delivery", DELIVERED: "delivered" };

/** Locks the order row for the rest of the transaction. */
export async function lockOrder(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("Order");
  return tx.order.findUniqueOrThrow({ where: { id: orderId } });
}

export async function changeStatus(
  tx: Tx,
  orderId: string,
  to: OrderStatus,
  opts: { note?: string | null; userId?: string | null; event?: OrderEvent; extra?: Prisma.OrderUpdateInput },
): Promise<(string | null)[]> {
  const order = await lockOrder(tx, orderId);
  if (order.status === to) return [];
  if (!TRANSITIONS[order.status].includes(to)) throw invalidState(`An order cannot move from ${order.status} to ${to}`);
  const now = new Date();
  await tx.order.update({
    where: { id: orderId },
    data: {
      status: to,
      // In-store sales never ship; their shipping status stays NOT_REQUIRED.
      shippingStatus: order.shippingStatus === "NOT_REQUIRED" ? undefined : SHIPPING_STATUS_FOR[to],
      deliveredAt: to === "DELIVERED" ? now : undefined,
      cancelledAt: to === "CANCELLED" ? now : undefined,
      confirmedAt: to === "CONFIRMED" ? now : undefined,
      ...opts.extra,
    },
  });
  await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: to, note: opts.note ?? null, changedById: opts.userId ?? null } });
  const eventType = opts.event?.type ?? EVENT_FOR[to];
  if (!eventType) return [];
  return orderEventNotifications(tx, orderId, opts.event ?? ({ type: eventType } as OrderEvent));
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export const placeOrderSchema = z.object({
  shippingAddressId: z.uuid(),
  billingAddressId: z.uuid().optional(),
  couponCode: z.string().trim().max(30).nullable().optional(),
  notes: z.string().trim().max(500).optional(),
  /** If sent, the order is refused when the server total differs (prices changed since the quote). */
  expectedGrandTotal: z.number().int().min(0).optional(),
});

export const quoteSchema = z.object({ shippingAddressId: z.uuid(), couponCode: z.string().trim().max(30).nullable().optional() });

export const addressSnapshot = (a: Address) => ({
  fullName: a.fullName,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  landmark: a.landmark,
  city: a.city,
  state: a.state,
  stateCode: a.stateCode,
  postalCode: a.postalCode,
  country: a.country,
});

/**
 * Splits each priced line across warehouses (priority order) using the
 * locked stock rows. Throws OUT_OF_STOCK if total availability is short.
 */
export async function allocateOnline(tx: Tx, quote: Quote): Promise<Map<string, { warehouseId: string; quantity: number }[]>> {
  const warehouses = await onlineWarehouses(tx);
  if (!warehouses.length) throw new AppError(409, "NO_FULFILMENT_WAREHOUSE", "No warehouse is configured to fulfil online orders");
  const rows = await lockLevels(tx, quote.lines.flatMap((l) => warehouses.map((w) => ({ variantId: l.variantId, warehouseId: w.id }))));
  const result = new Map<string, { warehouseId: string; quantity: number }[]>();
  for (const line of quote.lines) {
    let remaining = line.quantity;
    const parts: { warehouseId: string; quantity: number }[] = [];
    // Prefer a single warehouse that can ship the whole line, then split.
    const whole = warehouses.find((w) => {
      const r = rows.get(`${line.variantId}:${w.id}`)!;
      return r.on_hand - r.reserved >= line.quantity;
    });
    if (whole) parts.push({ warehouseId: whole.id, quantity: line.quantity });
    else {
      for (const w of warehouses) {
        const r = rows.get(`${line.variantId}:${w.id}`)!;
        const take = Math.min(Math.max(0, r.on_hand - r.reserved), remaining);
        if (take > 0) parts.push({ warehouseId: w.id, quantity: take });
        remaining -= take;
        if (remaining === 0) break;
      }
      if (remaining > 0) {
        const available = warehouses.reduce((s, w) => s + Math.max(0, rows.get(`${line.variantId}:${w.id}`)!.on_hand - rows.get(`${line.variantId}:${w.id}`)!.reserved), 0);
        throw new InsufficientStockError(line.sku, available, line.quantity);
      }
    }
    result.set(line.variantId, parts);
  }
  return result;
}

interface CreateOrderParams {
  channel: SalesChannel;
  quote: Quote;
  allocations: Map<string, { warehouseId: string; quantity: number }[]>;
  userId: string | null;
  createdById: string | null;
  customer: { name: string | null; email: string | null; phone: string | null };
  shippingAddress: object | null;
  billingAddress: object | null;
  warehouseId: string | null;
  notes?: string | null;
  idempotencyKey: string | null;
  reservationExpiresAt: Date | null;
}

/** Persists an order exactly as priced by the server. Shared by online checkout and POS. */
export async function createOrderRecord(tx: Tx, p: CreateOrderParams) {
  const orderNumber = await nextOrderNumber(tx, p.channel === "POS" ? "POS" : "ORD");
  const q = p.quote;
  const order = await tx.order.create({
    data: {
      orderNumber,
      channel: p.channel,
      userId: p.userId,
      customerName: p.customer.name,
      customerEmail: p.customer.email,
      customerPhone: p.customer.phone,
      status: "PENDING",
      paymentStatus: "CREATED",
      shippingStatus: p.channel === "POS" ? "NOT_REQUIRED" : "PENDING",
      subtotal: q.subtotal,
      discountTotal: q.discountTotal,
      taxTotal: q.taxTotal,
      shippingTotal: q.shipping.total,
      roundOff: q.roundOff,
      grandTotal: q.grandTotal,
      pricesIncludeTax: q.pricesIncludeTax,
      sellerStateCode: q.sellerStateCode,
      placeOfSupply: q.placeOfSupply,
      couponId: q.coupon?.valid ? q.coupon.couponId : null,
      couponCode: q.coupon?.valid ? q.coupon.code : null,
      shippingAddress: (p.shippingAddress ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      billingAddress: (p.billingAddress ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      warehouseId: p.warehouseId,
      notes: p.notes ?? null,
      idempotencyKey: p.idempotencyKey,
      createdById: p.createdById,
      reservationExpiresAt: p.reservationExpiresAt,
    },
  });

  // One order item per (variant, warehouse); split amounts proportionally.
  const items: Prisma.OrderItemCreateManyInput[] = [];
  for (const line of q.lines.filter((l) => l.purchasable)) {
    const parts = p.allocations.get(line.variantId) ?? [];
    const weights = parts.map((x) => x.quantity);
    const split = (amount: number) => allocate(amount, weights);
    const [disc, taxable, cgst, sgst, igst, tax, total] = [
      line.discountAmount,
      line.taxableAmount,
      line.cgstAmount,
      line.sgstAmount,
      line.igstAmount,
      line.taxAmount,
      line.lineTotal,
    ].map(split);
    parts.forEach((part, i) =>
      items.push({
        orderId: order.id,
        productId: line.productId,
        variantId: line.variantId,
        warehouseId: part.warehouseId,
        sku: line.sku,
        productName: line.name,
        variantTitle: line.variantTitle,
        hsnCode: line.hsnCode,
        imageUrl: line.imageUrl,
        quantity: part.quantity,
        mrp: line.mrp,
        unitPrice: line.unitPrice,
        discountAmount: disc![i]!,
        taxableAmount: taxable![i]!,
        taxRateBps: line.taxRateBps,
        cgstAmount: cgst![i]!,
        sgstAmount: sgst![i]!,
        igstAmount: igst![i]!,
        taxAmount: tax![i]!,
        lineTotal: total![i]!,
      }),
    );
  }
  await tx.orderItem.createMany({ data: items });
  await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: "PENDING", changedById: p.createdById ?? p.userId } });

  if (q.coupon?.valid && q.coupon.couponId) {
    // Lock the coupon so concurrent orders cannot exceed its usage limit.
    await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${q.coupon.couponId}::uuid FOR UPDATE`;
    const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: q.coupon.couponId } });
    const counts = await redemptionCounts(tx, coupon.id, p.userId);
    if (coupon.usageLimit != null && counts.total >= coupon.usageLimit) throw unprocessable("This coupon has reached its usage limit", "COUPON_INVALID");
    if (coupon.perUserLimit != null && p.userId && counts.mine >= coupon.perUserLimit) throw unprocessable("You have already used this coupon", "COUPON_INVALID");
    await tx.couponRedemption.create({ data: { couponId: coupon.id, userId: p.userId, orderId: order.id, discountAmount: q.couponDiscountTotal, status: "ACTIVE" } });
  }
  return order;
}

export async function checkoutQuote(userId: string, input: z.infer<typeof quoteSchema>) {
  const address = await getOwnedAddress(userId, input.shippingAddressId);
  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: true } });
  if (!cart?.items.length) throw badRequest("Your cart is empty", "CART_EMPTY");
  const couponCode = input.couponCode !== undefined ? input.couponCode : cart.couponCode;
  const shippingRate = await providerRate(address.postalCode, cart.items);
  const quote = await priceLines(cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), {
    channel: "ONLINE",
    couponCode,
    userId,
    placeOfSupply: address.stateCode,
    includeShipping: true,
    shippingRate,
  });
  // Stock check without locks (the real check happens under lock at placement).
  const stock = await availabilityByVariant(quote.lines.map((l) => l.variantId));
  const issues = quote.lines
    .map((l) => {
      const available = stock.get(l.variantId)?.available ?? 0;
      if (!l.purchasable) return `${l.name}: no longer available`;
      if (available < l.quantity) return available <= 0 ? `${l.name} (${l.variantTitle}) is out of stock` : `Only ${available} of ${l.name} (${l.variantTitle}) left`;
      return null;
    })
    .filter((x): x is string => !!x);
  if (quote.coupon && !quote.coupon.valid && quote.coupon.message) issues.push(quote.coupon.message);
  return { ...quote, shippingAddress: addressSnapshot(address), issues, canPlaceOrder: issues.length === 0 && quote.grandTotal >= 100 };
}

export async function placeOnlineOrder(userId: string, input: z.infer<typeof placeOrderSchema>, idempotencyKey: string) {
  const checkout = await getSetting("checkout");
  const shipping = await getOwnedAddress(userId, input.shippingAddressId);
  const billing = input.billingAddressId ? await getOwnedAddress(userId, input.billingAddressId) : shipping;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, phone: true, profile: { select: { firstName: true, lastName: true } } } });
  const cartLines = await prisma.cartItem.findMany({ where: { cart: { userId } }, select: { variantId: true, quantity: true } });
  // Courier rates are fetched before the transaction (network call).
  const shippingRate = await providerRate(shipping.postalCode, cartLines);

  const order = await withTransaction(async (tx) => {
    const cart = await tx.cart.findUnique({ where: { userId }, include: { items: true } });
    if (!cart?.items.length) throw badRequest("Your cart is empty", "CART_EMPTY");
    const couponCode = input.couponCode !== undefined ? input.couponCode : cart.couponCode;
    const quote = await priceLines(cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), {
      channel: "ONLINE",
      couponCode,
      userId,
      placeOfSupply: shipping.stateCode,
      includeShipping: true,
      shippingRate,
      db: tx,
    });
    const unavailable = quote.lines.filter((l) => !l.purchasable);
    if (unavailable.length) throw new AppError(409, "NOT_AVAILABLE", `${unavailable.map((l) => l.name).join(", ")} can no longer be purchased. Remove it from your cart.`);
    if (couponCode && !quote.coupon?.valid) throw unprocessable(quote.coupon?.message ?? "This coupon cannot be applied", "COUPON_INVALID");
    if (input.expectedGrandTotal !== undefined && input.expectedGrandTotal !== quote.grandTotal) {
      throw new AppError(409, "PRICE_CHANGED", "Prices or offers changed since you reviewed your order. Please review the updated total.");
    }
    if (quote.grandTotal < 100) throw badRequest("Order total must be at least ₹1");

    const allocations = await allocateOnline(tx, quote);
    const expiresAt = new Date(Date.now() + checkout.reservationTtlMinutes * 60_000);
    const created = await createOrderRecord(tx, {
      channel: "ONLINE",
      quote,
      allocations,
      userId,
      createdById: null,
      customer: {
        name: [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" ") || shipping.fullName,
        email: user.email,
        phone: user.phone ?? shipping.phone,
      },
      shippingAddress: addressSnapshot(shipping),
      billingAddress: addressSnapshot(billing),
      warehouseId: null,
      notes: input.notes ?? null,
      idempotencyKey: `${userId}:${idempotencyKey}`,
      reservationExpiresAt: expiresAt,
    });
    const reservations: ReservationLine[] = [...allocations.entries()].flatMap(([variantId, parts]) => parts.map((p) => ({ variantId, ...p })));
    await reserveStock(tx, reservations, expiresAt, { orderId: created.id, orderNumber: created.orderNumber, userId });
    // The order now owns these items; the cart is emptied.
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return created;
  });
  return getOrderForCustomer(userId, order.orderNumber);
}

/** Courier rate when shipping.mode = PROVIDER_RATES (otherwise the flat rate applies). */
async function providerRate(postalCode: string, lines: { variantId: string; quantity: number }[]) {
  const { mode } = await getSetting("shipping");
  if (mode !== "PROVIDER_RATES" || !lines.length) return null;
  const weight = await cartWeightGrams(lines);
  const value = (await priceLines(lines, { channel: "ONLINE", includeShipping: false })).grandTotal;
  return shippingRateFor(postalCode, weight, value);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export const CUSTOMER_CANCELLABLE = new Set<OrderStatus>(["PENDING", "CONFIRMED"]);
export const STAFF_CANCELLABLE = new Set<OrderStatus>(["PENDING", "CONFIRMED", "PROCESSING", "PACKED"]);

/**
 * Cancels an order that has not shipped. Unpaid orders release their
 * reservations; paid orders put the stock back and are refunded in full.
 */
export async function cancelOrder(orderId: string, opts: { reason: string; actor: AuditContext; by: "customer" | "staff" | "system"; customerId?: string }) {
  // A payment may have completed moments ago; settle that first.
  await reconcileOrderPayments(orderId).catch(() => undefined);

  const result = await withTransaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (opts.customerId && order.userId !== opts.customerId) throw notFound("Order");
    const allowed = opts.by === "customer" ? CUSTOMER_CANCELLABLE : STAFF_CANCELLABLE;
    if (!allowed.has(order.status)) {
      throw invalidState(opts.by === "customer" ? "This order can no longer be cancelled. Contact support or request a return." : `Orders that are ${order.status} cannot be cancelled`);
    }
    const paid = order.paymentStatus === "PAID" || order.paymentStatus === "PARTIALLY_REFUNDED";
    if (order.status === "PENDING") {
      await releaseReservations(tx, { orderId, orderNumber: order.orderNumber, userId: opts.actor.userId, reason: `Order cancelled: ${opts.reason}` });
      await tx.payment.updateMany({ where: { orderId, status: { in: ["CREATED", "PENDING"] } }, data: { status: "FAILED", failureReason: "Order cancelled" } });
    } else {
      // Stock was already deducted at confirmation: put it back where it came from.
      const items = await tx.orderItem.findMany({ where: { orderId } });
      await applyMovements(
        tx,
        items.map((i) => ({ variantId: i.variantId, warehouseId: i.warehouseId, bucket: "ON_HAND" as const, delta: i.quantity, type: "RETURN" as const })),
        { referenceType: "ORDER", referenceId: orderId, referenceNumber: order.orderNumber, userId: opts.actor.userId, notes: "Order cancelled before shipment; restocked" },
      );
    }
    await tx.couponRedemption.updateMany({ where: { orderId, status: { in: ["ACTIVE", "CONFIRMED"] } }, data: { status: "CANCELLED" } });
    if (order.couponId && order.status !== "PENDING") await tx.coupon.update({ where: { id: order.couponId }, data: { usedCount: { decrement: 1 } } });
    const ids = await changeStatus(tx, orderId, "CANCELLED", {
      note: opts.reason,
      userId: opts.actor.userId,
      event: { type: "cancelled", reason: opts.reason, refundNote: paid ? "A full refund has been initiated to your original payment method." : null },
      extra: { cancelReason: opts.reason },
    });
    await audit(tx, opts.actor, { action: "order.cancel", entityType: "order", entityId: orderId, oldValue: { status: order.status }, newValue: { status: "CANCELLED", reason: opts.reason, by: opts.by } });
    return { ids, paid, orderNumber: order.orderNumber };
  });
  await dispatchNotifications(result.ids);

  // The cancellation stands even if the refund fails: the FAILED refund is
  // listed under Refunds for a retry, and the caller is told about it.
  let refundError: string | null = null;
  if (result.paid) {
    try {
      await refundOrderInFull(orderId, `Order cancelled: ${opts.reason}`, opts.actor, `cancel:${orderId}`);
    } catch (err) {
      refundError = err instanceof Error ? err.message : "The refund could not be completed";
      logger.error({ orderId, err: refundError }, "automatic refund after cancellation failed");
    }
  }
  return { ...result, refundError };
}

// ---------------------------------------------------------------------------
// Staff status updates
// ---------------------------------------------------------------------------

export const statusUpdateSchema = z.object({ status: z.enum(["PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]), note: z.string().trim().max(500).optional() });

export async function updateStatusByStaff(orderId: string, to: OrderStatus, note: string | undefined, ctx: AuditContext) {
  if (!MANUAL_TRANSITIONS.has(to)) throw forbidden(`${to} is set automatically`);
  const ids = await withTransaction(async (tx) => {
    const before = await lockOrder(tx, orderId);
    if (before.paymentStatus !== "PAID" && before.paymentStatus !== "PARTIALLY_REFUNDED") throw invalidState("Only paid orders can be fulfilled");
    const ids = await changeStatus(tx, orderId, to, { note, userId: ctx.userId });
    await audit(tx, ctx, { action: "order.status", entityType: "order", entityId: orderId, oldValue: before.status, newValue: to });
    return ids;
  });
  await dispatchNotifications(ids);
  return getOrderForStaff(orderId);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const detailInclude = {
  items: { orderBy: { createdAt: "asc" } },
  statusHistory: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "asc" } },
  refunds: { orderBy: { createdAt: "asc" } },
  shipments: { orderBy: { createdAt: "asc" }, include: { events: { orderBy: { occurredAt: "desc" } } } },
  invoice: { select: { id: true, invoiceNumber: true, issuedAt: true, status: true } },
  creditNotes: { select: { id: true, creditNoteNumber: true, total: true, issuedAt: true } },
  returnRequests: { orderBy: { createdAt: "desc" }, include: { items: true } },
  warehouse: { select: { id: true, code: true, name: true } },
} satisfies Prisma.OrderInclude;

export async function getOrderForCustomer(userId: string, orderNumber: string) {
  const order = await prisma.order.findFirst({ where: { orderNumber, userId }, include: detailInclude });
  if (!order) throw notFound("Order");
  const returns = await getSetting("returns");
  const returnWindowEnds = order.deliveredAt ? new Date(order.deliveredAt.getTime() + returns.windowDays * 86_400_000) : null;
  const { payments, ...rest } = order;
  return {
    ...rest,
    payments: payments.map((p) => ({ id: p.id, provider: p.provider, method: p.method, status: p.status, amount: p.amount, paidAt: p.paidAt })),
    canCancel: CUSTOMER_CANCELLABLE.has(order.status),
    canPay: order.status === "PENDING" && order.paymentStatus !== "PAID" && (!order.reservationExpiresAt || order.reservationExpiresAt > new Date()),
    canReturn: order.status === "DELIVERED" && !!returnWindowEnds && returnWindowEnds > new Date(),
    returnWindowEnds,
  };
}

export async function getOrderForStaff(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { ...detailInclude, user: { select: { id: true, email: true, phone: true } }, createdBy: { select: { id: true, email: true } } },
  });
  if (!order) throw notFound("Order");
  return { ...order, allowedTransitions: TRANSITIONS[order.status].filter((s) => MANUAL_TRANSITIONS.has(s)), canCancel: STAFF_CANCELLABLE.has(order.status) };
}

export const orderListQuery = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURN_REQUESTED", "RETURNED", "REFUNDED"]).optional(),
  paymentStatus: z.enum(["CREATED", "PENDING", "PAID", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]).optional(),
  channel: z.enum(["ONLINE", "POS"]).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  userId: z.uuid().optional(),
});

const listSelect = {
  id: true,
  orderNumber: true,
  channel: true,
  status: true,
  paymentStatus: true,
  shippingStatus: true,
  grandTotal: true,
  customerName: true,
  customerEmail: true,
  customerPhone: true,
  placedAt: true,
  _count: { select: { items: true } },
  items: { take: 1, select: { imageUrl: true, productName: true } },
} satisfies Prisma.OrderSelect;

export async function listOrders(q: z.infer<typeof orderListQuery>, page: Pagination) {
  const where: Prisma.OrderWhereInput = {
    status: q.status,
    paymentStatus: q.paymentStatus,
    channel: q.channel,
    userId: q.userId,
    placedAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    OR: q.q
      ? [
          { orderNumber: { contains: q.q.toUpperCase() } },
          { customerEmail: { contains: q.q, mode: "insensitive" } },
          { customerPhone: { contains: q.q } },
          { customerName: { contains: q.q, mode: "insensitive" } },
        ]
      : undefined,
  };
  const [items, total] = await Promise.all([prisma.order.findMany({ where, select: listSelect, orderBy: { placedAt: "desc" }, ...pageArgs(page) }), prisma.order.count({ where })]);
  return { items, meta: pageMeta(page, total) };
}

export async function listCustomerOrders(userId: string, page: Pagination) {
  return listOrders({ userId }, page);
}
