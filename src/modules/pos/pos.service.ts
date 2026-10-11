import { z } from "zod";
import { Prisma, type PosCart } from "@prisma/client";
import { onlinePaymentsEnabled } from "../../config/env";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { AppError, badRequest, forbidden, invalidState, notFound, unprocessable } from "../../common/errors/app-error";
import { applyBps } from "../../common/utils/money";
import { normalizePhone } from "../../common/utils/phone";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { audit, type AuditContext } from "../audit/audit.service";
import type { Principal } from "../auth/principal";
import { scanLookup } from "../codes/scan.service";
import { imageView } from "../media/image-view";
import { queueLowStockCheck } from "../inventory/inventory.service";
import { reserveStock, sellDirect } from "../inventory/reservations";
import { InsufficientStockError, lockLevels } from "../inventory/stock";
import { dispatchNotifications } from "../notifications/notifications.service";
import { changeStatus, createOrderRecord } from "../orders/orders.service";
import { priceLines, type Quote } from "../pricing/pricing.service";
import { getSetting } from "../settings/settings.service";

export const PAYMENT_METHODS = ["CASH", "UPI_MANUAL", "CARD_MANUAL", "RAZORPAY"] as const;

export const openCartSchema = z.object({ warehouseId: z.uuid() });
export const scanSchema = z.object({ code: z.string().min(1).max(500), quantity: z.number().int().min(1).max(999).default(1), override: z.boolean().default(false) });
export const addItemSchema = z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(999).default(1), override: z.boolean().default(false) });
export const updateItemSchema = z.object({ quantity: z.number().int().min(1).max(999).optional(), manualDiscount: z.number().int().min(0).optional(), override: z.boolean().optional() });
export const patchCartSchema = z.object({
  customerName: z.string().trim().max(100).nullable().optional(),
  customerPhone: z.string().trim().max(20).nullable().optional(),
  customerEmail: z.email().nullable().optional(),
  couponCode: z.string().trim().max(30).nullable().optional(),
  manualDiscount: z.number().int().min(0).optional(),
  manualDiscountReason: z.string().trim().max(200).nullable().optional(),
});
export const checkoutSchema = z
  .object({
    paymentMethod: z.enum(PAYMENT_METHODS),
    referenceNumber: z.string().trim().max(60).optional(),
    amountTendered: z.number().int().min(0).optional(),
  })
  .refine((c) => !["UPI_MANUAL", "CARD_MANUAL"].includes(c.paymentMethod) || !!c.referenceNumber, { message: "Enter the UPI / card transaction reference", path: ["referenceNumber"] });

/** The payment methods switched on in Settings, without the gateway while none is connected. */
async function posSettings() {
  const pos = await getSetting("pos");
  return onlinePaymentsEnabled ? pos : { ...pos, enabledPaymentMethods: pos.enabledPaymentMethods.filter((m) => m !== "RAZORPAY") };
}

export async function posConfig() {
  const { enabledPaymentMethods, maxManualDiscountBps } = await posSettings();
  return { enabledPaymentMethods, maxManualDiscountBps };
}

async function getOpenCart(cartId: string, cashier: Principal): Promise<PosCart> {
  const cart = await prisma.posCart.findUnique({ where: { id: cartId } });
  if (!cart) throw notFound("Bill");
  if (cart.cashierId !== cashier.userId && !cashier.permissions.includes("orders.update")) throw forbidden("This bill belongs to another cashier");
  if (cart.status !== "OPEN") throw invalidState("This bill is already closed");
  return cart;
}

export async function openCart(cashier: Principal, warehouseId: string) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { status: true } });
  if (!warehouse || warehouse.status !== "ACTIVE") throw badRequest("Select an active billing location");
  const existing = await prisma.posCart.findFirst({ where: { cashierId: cashier.userId, warehouseId, status: "OPEN" }, orderBy: { createdAt: "desc" } });
  const cart = existing ?? (await prisma.posCart.create({ data: { cashierId: cashier.userId, warehouseId } }));
  return cartView(cart.id);
}

/** Server-priced bill with per-line stock in the billing warehouse. */
export async function cartView(cartId: string) {
  const cart = await prisma.posCart.findUniqueOrThrow({
    where: { id: cartId },
    include: {
      items: { orderBy: { createdAt: "asc" }, include: { variant: { select: { title: true, product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } } } } } } },
      warehouse: { select: { id: true, code: true, name: true, stateCode: true } },
    },
  });
  const quote = cart.items.length ? await quoteFor(cart, cart.warehouse.stateCode) : null;
  const levels = await prisma.inventoryLevel.findMany({ where: { warehouseId: cart.warehouseId, variantId: { in: cart.items.map((i) => i.variantId) } } });
  return {
    id: cart.id,
    status: cart.status,
    warehouse: cart.warehouse,
    customer: { name: cart.customerName, phone: cart.customerPhone, email: cart.customerEmail },
    couponCode: cart.couponCode,
    manualDiscount: cart.manualDiscount,
    manualDiscountReason: cart.manualDiscountReason,
    orderId: cart.orderId,
    items: cart.items.map((i) => {
      const line = quote?.lines.find((l) => l.variantId === i.variantId);
      const lvl = levels.find((l) => l.variantId === i.variantId);
      const available = lvl ? lvl.onHand - lvl.reserved : 0;
      return {
        id: i.id,
        variantId: i.variantId,
        sku: i.sku,
        name: i.variant.product.name,
        variant: i.variant.title,
        image: i.variant.product.images[0] ? imageView(i.variant.product.images[0]).thumb : null,
        quantity: i.quantity,
        manualDiscount: i.manualDiscount,
        stockOverride: i.stockOverride,
        available,
        stockIssue: available < i.quantity ? (i.stockOverride ? "Selling beyond stock (override)" : "Not enough stock") : null,
        mrp: line?.mrp ?? 0,
        unitPrice: line?.unitPrice ?? 0,
        discountAmount: line?.discountAmount ?? 0,
        taxRateBps: line?.taxRateBps ?? 0,
        taxAmount: line?.taxAmount ?? 0,
        lineTotal: line?.lineTotal ?? 0,
      };
    }),
    totals: quote
      ? {
          itemCount: quote.itemCount,
          subtotal: quote.subtotal,
          discountTotal: quote.discountTotal,
          autoDiscountTotal: quote.autoDiscountTotal,
          couponDiscountTotal: quote.couponDiscountTotal,
          manualDiscountTotal: quote.manualDiscountTotal,
          taxableTotal: quote.taxableTotal,
          cgstTotal: quote.cgstTotal,
          sgstTotal: quote.sgstTotal,
          igstTotal: quote.igstTotal,
          taxTotal: quote.taxTotal,
          roundOff: quote.roundOff,
          grandTotal: quote.grandTotal,
        }
      : { itemCount: 0, subtotal: 0, discountTotal: 0, autoDiscountTotal: 0, couponDiscountTotal: 0, manualDiscountTotal: 0, taxableTotal: 0, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, taxTotal: 0, roundOff: 0, grandTotal: 0 },
    coupon: quote?.coupon ?? null,
  };
}

async function quoteFor(cart: { items: { variantId: string; quantity: number; manualDiscount: number }[]; couponCode: string | null; manualDiscount: number; customerPhone: string | null }, stateCode: string, db?: Tx): Promise<Quote> {
  const customer = cart.customerPhone ? await (db ?? prisma).user.findUnique({ where: { phone: cart.customerPhone }, select: { id: true } }) : null;
  return priceLines(
    cart.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, manualDiscount: i.manualDiscount })),
    { channel: "POS", couponCode: cart.couponCode, userId: customer?.id ?? null, sellerStateCode: stateCode, placeOfSupply: stateCode, includeShipping: false, billDiscount: cart.manualDiscount, db },
  );
}

async function assertManualDiscountCap(cartId: string, extra: { itemId?: string; lineDiscount?: number; billDiscount?: number }) {
  const { maxManualDiscountBps } = await getSetting("pos");
  const cart = await prisma.posCart.findUniqueOrThrow({ where: { id: cartId }, include: { items: { include: { variant: { select: { sellingPrice: true } } } } } });
  const gross = cart.items.reduce((s, i) => s + i.variant.sellingPrice * i.quantity, 0);
  const lineDiscounts = cart.items.reduce((s, i) => s + (i.id === extra.itemId ? (extra.lineDiscount ?? 0) : i.manualDiscount), 0);
  const total = lineDiscounts + (extra.billDiscount ?? cart.manualDiscount);
  const cap = applyBps(gross, maxManualDiscountBps);
  if (total > cap) throw badRequest(`Manual discounts are capped at ${maxManualDiscountBps / 100}% of the bill (₹${(cap / 100).toFixed(2)})`, "DISCOUNT_LIMIT");
}

async function addVariant(cart: PosCart, variantId: string, sku: string, quantity: number, override: boolean, cashier: Principal, ctx: AuditContext) {
  if (override && !cashier.permissions.includes("pos.override_stock")) throw forbidden("You are not allowed to sell items that are out of stock");
  const existing = await prisma.posCartItem.findUnique({ where: { posCartId_variantId: { posCartId: cart.id, variantId } } });
  const next = (existing?.quantity ?? 0) + quantity;
  const lvl = await prisma.inventoryLevel.findUnique({ where: { variantId_warehouseId: { variantId, warehouseId: cart.warehouseId } } });
  const available = lvl ? lvl.onHand - lvl.reserved : 0;
  if (next > available && !override && !existing?.stockOverride) {
    throw new AppError(409, "OUT_OF_STOCK", available <= 0 ? "Out of stock." : `Only ${available} in stock at this location.`, [{ path: sku, message: `available ${Math.max(0, available)}` }]);
  }
  const useOverride = override || !!existing?.stockOverride;
  await prisma.posCartItem.upsert({
    where: { posCartId_variantId: { posCartId: cart.id, variantId } },
    create: { posCartId: cart.id, variantId, sku, quantity: next, unitPrice: 0, stockOverride: useOverride && next > available, addedById: cashier.userId },
    update: { quantity: next, stockOverride: useOverride && next > available },
  });
  if (override && next > available) {
    await audit(prisma, ctx, { action: "pos.override_stock", entityType: "pos_cart", entityId: cart.id, newValue: { sku, quantity: next, available } });
  }
}

export async function scan(cartId: string, input: z.infer<typeof scanSchema>, cashier: Principal, ctx: AuditContext) {
  const cart = await getOpenCart(cartId, cashier);
  // Throws the spec's messages: not found / inactive / discontinued / duplicate.
  const { product } = await scanLookup(input.code, cart.warehouseId);
  if (product.stockStatus !== "IN_STOCK" && !input.override) {
    throw new AppError(409, "OUT_OF_STOCK", product.message ?? "Out of stock.", [{ path: product.sku, message: product.stockStatus }]);
  }
  await addVariant(cart, product.variantId, product.sku, input.quantity, input.override, cashier, ctx);
  return { scanned: product, cart: await cartView(cartId) };
}

export async function addItem(cartId: string, input: z.infer<typeof addItemSchema>, cashier: Principal, ctx: AuditContext) {
  const cart = await getOpenCart(cartId, cashier);
  const v = await prisma.productVariant.findUnique({ where: { id: input.variantId }, select: { sku: true, status: true, product: { select: { status: true } } } });
  if (!v || v.status !== "ACTIVE" || v.product.status !== "ACTIVE") throw new AppError(409, "PRODUCT_INACTIVE", "This product is not available for sale.");
  await addVariant(cart, input.variantId, v.sku, input.quantity, input.override, cashier, ctx);
  return cartView(cartId);
}

export async function updateItem(cartId: string, itemId: string, input: z.infer<typeof updateItemSchema>, cashier: Principal, ctx: AuditContext) {
  const cart = await getOpenCart(cartId, cashier);
  const item = await prisma.posCartItem.findFirst({ where: { id: itemId, posCartId: cart.id } });
  if (!item) throw notFound("Bill line");
  if (input.manualDiscount !== undefined && input.manualDiscount !== item.manualDiscount) {
    if (!cashier.permissions.includes("pos.manual_discount")) throw forbidden("You are not allowed to give manual discounts");
    await assertManualDiscountCap(cartId, { itemId, lineDiscount: input.manualDiscount });
    await audit(prisma, ctx, { action: "pos.manual_discount", entityType: "pos_cart", entityId: cart.id, oldValue: item.manualDiscount, newValue: { sku: item.sku, manualDiscount: input.manualDiscount } });
  }
  if (input.quantity !== undefined && input.quantity > item.quantity) {
    const lvl = await prisma.inventoryLevel.findUnique({ where: { variantId_warehouseId: { variantId: item.variantId, warehouseId: cart.warehouseId } } });
    const available = lvl ? lvl.onHand - lvl.reserved : 0;
    const override = input.override ?? item.stockOverride;
    if (input.quantity > available && !override) throw new AppError(409, "OUT_OF_STOCK", `Only ${Math.max(0, available)} in stock at this location.`);
    if (input.quantity > available && !cashier.permissions.includes("pos.override_stock")) throw forbidden("You are not allowed to sell items that are out of stock");
  }
  await prisma.posCartItem.update({
    where: { id: itemId },
    data: { quantity: input.quantity, manualDiscount: input.manualDiscount, stockOverride: input.override },
  });
  return cartView(cartId);
}

export async function removeItem(cartId: string, itemId: string, cashier: Principal) {
  const cart = await getOpenCart(cartId, cashier);
  const res = await prisma.posCartItem.deleteMany({ where: { id: itemId, posCartId: cart.id } });
  if (!res.count) throw notFound("Bill line");
  return cartView(cartId);
}

export async function patchCart(cartId: string, input: z.infer<typeof patchCartSchema>, cashier: Principal, ctx: AuditContext) {
  const cart = await getOpenCart(cartId, cashier);
  let phone: string | null | undefined = input.customerPhone;
  if (phone) {
    phone = normalizePhone(phone);
    if (!phone) throw badRequest("Enter a valid mobile number");
  }
  if (input.manualDiscount !== undefined && input.manualDiscount !== cart.manualDiscount) {
    if (!cashier.permissions.includes("pos.manual_discount")) throw forbidden("You are not allowed to give manual discounts");
    await assertManualDiscountCap(cartId, { billDiscount: input.manualDiscount });
    if (input.manualDiscount > 0 && !input.manualDiscountReason && !cart.manualDiscountReason) throw badRequest("Give a reason for the manual discount");
    await audit(prisma, ctx, { action: "pos.manual_discount", entityType: "pos_cart", entityId: cart.id, oldValue: cart.manualDiscount, newValue: { bill: input.manualDiscount, reason: input.manualDiscountReason } });
  }
  if (input.couponCode) {
    const items = await prisma.posCartItem.findMany({ where: { posCartId: cart.id } });
    const wh = await prisma.warehouse.findUniqueOrThrow({ where: { id: cart.warehouseId } });
    const q = await quoteFor({ items, couponCode: input.couponCode, manualDiscount: cart.manualDiscount, customerPhone: phone ?? cart.customerPhone }, wh.stateCode);
    if (!q.coupon?.valid) throw unprocessable(q.coupon?.message ?? "This coupon cannot be applied", "COUPON_INVALID");
  }
  await prisma.posCart.update({
    where: { id: cart.id },
    data: {
      customerName: input.customerName,
      customerPhone: phone,
      customerEmail: input.customerEmail,
      couponCode: input.couponCode === undefined ? undefined : input.couponCode ? input.couponCode.toUpperCase() : null,
      manualDiscount: input.manualDiscount,
      manualDiscountReason: input.manualDiscountReason,
    },
  });
  return cartView(cartId);
}

export async function abandonCart(cartId: string, cashier: Principal) {
  const cart = await getOpenCart(cartId, cashier);
  await prisma.posCart.update({ where: { id: cart.id }, data: { status: "ABANDONED" } });
  return { abandoned: true };
}

/**
 * Completes the sale. Cash / UPI / card: payment recorded by the cashier and
 * stock deducted immediately (SALE). Razorpay: stock reserved until the
 * gateway confirms, exactly like an online order.
 */
export async function checkout(cartId: string, input: z.infer<typeof checkoutSchema>, cashier: Principal, ctx: AuditContext) {
  const pos = await posSettings();
  if (!pos.enabledPaymentMethods.includes(input.paymentMethod)) throw badRequest(`${input.paymentMethod} is not enabled for in-store billing`);

  const result = await withTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM pos_carts WHERE id = ${cartId}::uuid FOR UPDATE`;
    if (!locked.length) throw notFound("Bill");
    const cart = await tx.posCart.findUniqueOrThrow({ where: { id: cartId }, include: { items: true, warehouse: true } });
    if (cart.cashierId !== cashier.userId && !cashier.permissions.includes("orders.update")) throw forbidden("This bill belongs to another cashier");
    if (cart.status !== "OPEN") throw invalidState("This bill has already been completed");
    if (!cart.items.length) throw badRequest("Scan at least one product");

    const quote = await quoteFor(cart, cart.warehouse.stateCode, tx);
    const unavailable = quote.lines.filter((l) => !l.purchasable);
    if (unavailable.length) throw new AppError(409, "PRODUCT_INACTIVE", `${unavailable.map((l) => l.sku).join(", ")} can no longer be sold`);
    if (cart.couponCode && !quote.coupon?.valid) throw unprocessable(quote.coupon?.message ?? "This coupon cannot be applied", "COUPON_INVALID");
    if (input.paymentMethod === "CASH" && input.amountTendered !== undefined && input.amountTendered < quote.grandTotal) {
      throw badRequest(`Cash received is less than the bill total (₹${(quote.grandTotal / 100).toFixed(2)})`);
    }

    // Stock check under lock, in the billing warehouse only.
    const rows = await lockLevels(tx, cart.items.map((i) => ({ variantId: i.variantId, warehouseId: cart.warehouseId })));
    const overrides = new Set(cart.items.filter((i) => i.stockOverride).map((i) => i.variantId));
    for (const line of quote.lines) {
      const r = rows.get(`${line.variantId}:${cart.warehouseId}`)!;
      if (r.on_hand - r.reserved < line.quantity && !overrides.has(line.variantId)) throw new InsufficientStockError(line.sku, r.on_hand - r.reserved, line.quantity);
    }

    const customer = cart.customerPhone ? await tx.user.findUnique({ where: { phone: cart.customerPhone }, select: { id: true, email: true } }) : null;
    const allocations = new Map(quote.lines.map((l) => [l.variantId, [{ warehouseId: cart.warehouseId, quantity: l.quantity }]]));
    const isGateway = input.paymentMethod === "RAZORPAY";
    const expiresAt = isGateway ? new Date(Date.now() + 15 * 60_000) : null;
    const order = await createOrderRecord(tx, {
      channel: "POS",
      quote,
      allocations,
      userId: customer?.id ?? null,
      createdById: cashier.userId,
      customer: { name: cart.customerName ?? "Walk-in customer", email: cart.customerEmail ?? customer?.email ?? null, phone: cart.customerPhone },
      shippingAddress: null,
      billingAddress: null,
      warehouseId: cart.warehouseId,
      notes: cart.manualDiscount ? `Manual discount: ${cart.manualDiscountReason ?? ""}` : null,
      idempotencyKey: `pos:${cart.id}`,
      reservationExpiresAt: expiresAt,
    });
    await tx.posCart.update({ where: { id: cart.id }, data: { status: "CHECKED_OUT", orderId: order.id } });
    const lines = quote.lines.map((l) => ({ variantId: l.variantId, warehouseId: cart.warehouseId, quantity: l.quantity }));
    const normal = lines.filter((l) => !overrides.has(l.variantId));
    const forced = lines.filter((l) => overrides.has(l.variantId));
    const refCtx = { orderId: order.id, orderNumber: order.orderNumber, userId: cashier.userId };

    if (isGateway) {
      await reserveStock(tx, normal, expiresAt!, refCtx);
      if (forced.length) await reserveStock(tx, forced, expiresAt!, { ...refCtx, allowNegative: true });
      await audit(tx, ctx, { action: "pos.sale.pending", entityType: "order", entityId: order.id, newValue: { cartId, paymentMethod: input.paymentMethod } });
      return { order, ids: [] as (string | null)[], variantIds: [] as string[], paid: false };
    }

    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: input.paymentMethod,
        method: ({ CASH: "cash", UPI_MANUAL: "upi", CARD_MANUAL: "card" } as Record<string, string>)[input.paymentMethod] ?? null,
        status: "PAID",
        amount: order.grandTotal,
        referenceNumber: input.referenceNumber ?? null,
        receivedById: cashier.userId,
        paidAt: new Date(),
      },
    });
    if (normal.length) await sellDirect(tx, normal, refCtx);
    if (forced.length) await sellDirect(tx, forced, { ...refCtx, allowNegative: true });
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: "PAID" } });
    await tx.couponRedemption.updateMany({ where: { orderId: order.id }, data: { status: "CONFIRMED" } });
    if (order.couponId) await tx.coupon.update({ where: { id: order.couponId }, data: { usedCount: { increment: 1 } } });
    const ids = await changeStatus(tx, order.id, "CONFIRMED", { note: `Paid at counter (${input.paymentMethod})`, userId: cashier.userId, event: { type: "confirmed" } });
    await changeStatus(tx, order.id, "DELIVERED", { note: "Handed over at the counter", userId: cashier.userId, event: { type: "delivered" } });
    await audit(tx, ctx, { action: "pos.sale", entityType: "order", entityId: order.id, newValue: { cartId, paymentMethod: input.paymentMethod, grandTotal: order.grandTotal, overrides: [...overrides] } });
    return { order, ids, variantIds: lines.map((l) => l.variantId), paid: true };
  });

  await dispatchNotifications(result.ids);
  if (result.paid) {
    await enqueue(QUEUE_NAMES.invoices, "invoice.issue", { orderId: result.order.id }, { jobId: `invoice-${result.order.id}` });
    await queueLowStockCheck(result.variantIds);
  }
  // A fresh bill is opened for the cashier at the same location.
  const next = await prisma.posCart.create({ data: { cashierId: cashier.userId, warehouseId: result.order.warehouseId! } });
  return {
    order: { id: result.order.id, orderNumber: result.order.orderNumber, grandTotal: result.order.grandTotal, paymentStatus: result.paid ? "PAID" : "PENDING" },
    requiresGatewayPayment: !result.paid,
    change: input.paymentMethod === "CASH" && input.amountTendered !== undefined ? input.amountTendered - result.order.grandTotal : null,
    nextCartId: next.id,
  };
}

export async function searchProducts(q: string, warehouseId: string) {
  const rows = await prisma.productVariant.findMany({
    where: {
      status: "ACTIVE",
      product: { status: "ACTIVE" },
      OR: [{ sku: { contains: q.toUpperCase() } }, { product: { name: { contains: q, mode: "insensitive" } } }, { codes: { some: { codeValue: q } } }],
    },
    take: 20,
    orderBy: [{ product: { name: "asc" } }, { position: "asc" }],
    select: {
      id: true,
      sku: true,
      title: true,
      mrp: true,
      sellingPrice: true,
      product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } } },
      inventoryLevels: { where: { warehouseId }, select: { onHand: true, reserved: true } },
    },
  });
  return rows.map((r) => ({
    variantId: r.id,
    sku: r.sku,
    name: r.product.name,
    variant: r.title,
    mrp: r.mrp,
    price: r.sellingPrice,
    available: r.inventoryLevels[0] ? r.inventoryLevels[0].onHand - r.inventoryLevels[0].reserved : 0,
    image: r.product.images[0] ? imageView(r.product.images[0]).thumb : null,
  }));
}

export async function recentSales(cashier: Principal, warehouseId: string | undefined, page: Pagination) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const where: Prisma.OrderWhereInput = { channel: "POS", warehouseId, placedAt: { gte: since }, createdById: cashier.permissions.includes("orders.read") ? undefined : cashier.userId };
  const [items, total, sum] = await Promise.all([
    prisma.order.findMany({ where, orderBy: { placedAt: "desc" }, ...pageArgs(page), select: { id: true, orderNumber: true, grandTotal: true, paymentStatus: true, status: true, customerName: true, placedAt: true, payments: { select: { provider: true } } } }),
    prisma.order.count({ where }),
    prisma.order.aggregate({ where: { ...where, paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED"] } }, _sum: { grandTotal: true } }),
  ]);
  return { items, meta: { ...pageMeta(page, total), salesTotal: sum._sum.grandTotal ?? 0 } };
}
