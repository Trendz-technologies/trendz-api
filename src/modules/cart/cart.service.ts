import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../database/prisma";
import { AppError, badRequest, notFound, unprocessable } from "../../common/errors/app-error";
import { randomToken } from "../../common/utils/crypto";
import { availabilityByVariant } from "../inventory/availability";
import { priceLines, type Quote } from "../pricing/pricing.service";
import { getSetting } from "../settings/settings.service";

export const GUEST_CART_COOKIE = "guest_cart";
const GUEST_CART_TTL_DAYS = 30;

export const addItemSchema = z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(1000).default(1) });
export const updateItemSchema = z.object({ quantity: z.number().int().min(0).max(1000) });
export const couponSchema = z.object({ code: z.string().trim().min(3).max(30) });

export interface CartRef {
  id: string;
  userId: string | null;
  couponCode: string | null;
}

/** Finds (or creates, when `create`) the cart for this request: the user's cart or a guest cart. */
export async function resolveCart(req: Request, res: Response, create: boolean): Promise<CartRef | null> {
  const select = { id: true, userId: true, couponCode: true };
  if (req.auth) {
    const existing = await prisma.cart.findUnique({ where: { userId: req.auth.userId }, select });
    if (existing || !create) return existing;
    return prisma.cart.upsert({ where: { userId: req.auth.userId }, create: { userId: req.auth.userId }, update: {}, select });
  }
  const token = req.cookies?.[GUEST_CART_COOKIE] as string | undefined;
  if (token) {
    const cart = await prisma.cart.findUnique({ where: { guestToken: token }, select });
    if (cart) return cart;
  }
  if (!create) return null;
  const guestToken = randomToken(32);
  res.cookie(GUEST_CART_COOKIE, guestToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/",
    maxAge: GUEST_CART_TTL_DAYS * 24 * 3600_000,
  });
  return prisma.cart.create({ data: { guestToken }, select });
}

/** On sign-in: move guest cart lines into the user's cart (quantities add up, capped). */
export async function mergeGuestCart(req: Request, res: Response, userId: string) {
  const token = req.cookies?.[GUEST_CART_COOKIE] as string | undefined;
  if (!token) return;
  const guest = await prisma.cart.findUnique({ where: { guestToken: token }, include: { items: true } });
  res.clearCookie(GUEST_CART_COOKIE, { path: "/", domain: env.COOKIE_DOMAIN });
  if (!guest) return;
  const { maxQuantityPerLine } = await getSetting("checkout");
  await prisma.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({ where: { userId }, create: { userId, couponCode: guest.couponCode }, update: {} });
    for (const item of guest.items) {
      const existing = await tx.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } } });
      const quantity = Math.min(maxQuantityPerLine, (existing?.quantity ?? 0) + item.quantity);
      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: cart.id, variantId: item.variantId } },
        create: { cartId: cart.id, variantId: item.variantId, quantity },
        update: { quantity },
      });
    }
    if (!cart.couponCode && guest.couponCode) await tx.cart.update({ where: { id: cart.id }, data: { couponCode: guest.couponCode } });
    await tx.cart.delete({ where: { id: guest.id } });
  });
}

export interface CartView extends Omit<Quote, "lines"> {
  id: string | null;
  items: (Quote["lines"][number] & { itemId: string; available: number; maxQuantity: number })[];
  issues: string[];
}

const EMPTY_TOTALS = (): Omit<CartView, "id" | "items" | "issues"> => ({
  itemCount: 0,
  subtotal: 0,
  discountTotal: 0,
  autoDiscountTotal: 0,
  couponDiscountTotal: 0,
  manualDiscountTotal: 0,
  taxableTotal: 0,
  cgstTotal: 0,
  sgstTotal: 0,
  igstTotal: 0,
  taxTotal: 0,
  shipping: { amount: 0, taxAmount: 0, taxRateBps: 0, total: 0, free: false, freeShippingThreshold: null, amountToFreeShipping: 0 },
  roundOff: 0,
  grandTotal: 0,
  coupon: null,
  pricesIncludeTax: true,
  sellerStateCode: "",
  placeOfSupply: "",
  interState: false,
  savings: 0,
});

/** Server-priced cart with per-line stock checks. */
export async function cartView(cart: CartRef | null, placeOfSupply?: string | null): Promise<CartView> {
  if (!cart) return { id: null, items: [], issues: [], ...EMPTY_TOTALS() };
  const items = await prisma.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { createdAt: "asc" } });
  if (!items.length) return { id: cart.id, items: [], issues: [], ...EMPTY_TOTALS(), coupon: cart.couponCode ? { code: cart.couponCode, valid: false, message: "Add items to use this coupon", discount: 0, couponId: null } : null };

  const [quote, stock, { maxQuantityPerLine }] = await Promise.all([
    priceLines(items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })), {
      channel: "ONLINE",
      couponCode: cart.couponCode,
      userId: cart.userId,
      placeOfSupply,
      includeShipping: true,
    }),
    availabilityByVariant(items.map((i) => i.variantId)),
    getSetting("checkout"),
  ]);

  const issues: string[] = [];
  const view = quote.lines.map((line) => {
    const item = items.find((i) => i.variantId === line.variantId)!;
    const available = stock.get(line.variantId)?.available ?? 0;
    let issue = line.issue;
    if (!issue && available <= 0) issue = "Out of stock";
    else if (!issue && available < line.quantity) issue = `Only ${available} left`;
    if (issue) issues.push(`${line.name} (${line.variantTitle}): ${issue}`);
    return { ...line, issue, itemId: item.id, available: Math.min(available, maxQuantityPerLine), maxQuantity: maxQuantityPerLine };
  });
  if (quote.coupon && !quote.coupon.valid && quote.coupon.message) issues.push(quote.coupon.message);
  return { ...quote, id: cart.id, items: view, issues };
}

async function assertPurchasable(variantId: string, quantity: number) {
  const { maxQuantityPerLine } = await getSetting("checkout");
  if (quantity > maxQuantityPerLine) throw badRequest(`You can buy at most ${maxQuantityPerLine} of an item per order`, "QUANTITY_LIMIT");
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { sku: true, status: true, product: { select: { status: true, category: { select: { isActive: true } } } } },
  });
  if (!v) throw notFound("Product");
  if (v.status !== "ACTIVE" || v.product.status !== "ACTIVE" || !v.product.category.isActive) {
    throw new AppError(409, "NOT_AVAILABLE", "This item is not available for purchase");
  }
  const available = (await availabilityByVariant([variantId])).get(variantId)?.available ?? 0;
  if (available < quantity) {
    throw new AppError(409, "OUT_OF_STOCK", available <= 0 ? "This item is out of stock" : `Only ${available} left in stock`);
  }
}

export async function addItem(cart: CartRef, variantId: string, quantity: number) {
  const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } });
  const next = (existing?.quantity ?? 0) + quantity;
  await assertPurchasable(variantId, next);
  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    create: { cartId: cart.id, variantId, quantity: next },
    update: { quantity: next },
  });
  await prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
}

export async function updateItem(cart: CartRef, itemId: string, quantity: number) {
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
  if (!item) throw notFound("Cart item");
  if (quantity === 0) {
    await prisma.cartItem.delete({ where: { id: itemId } });
    return;
  }
  // Decreasing is always allowed; increasing is stock-checked.
  if (quantity > item.quantity) await assertPurchasable(item.variantId, quantity);
  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
}

export async function removeItem(cart: CartRef, itemId: string) {
  const res = await prisma.cartItem.deleteMany({ where: { id: itemId, cartId: cart.id } });
  if (!res.count) throw notFound("Cart item");
}

export async function clearCart(cartId: string) {
  await prisma.$transaction([prisma.cartItem.deleteMany({ where: { cartId } }), prisma.cart.update({ where: { id: cartId }, data: { couponCode: null } })]);
}

export async function applyCoupon(cart: CartRef, code: string) {
  const view = await cartView({ ...cart, couponCode: code });
  if (!view.coupon?.valid) throw unprocessable(view.coupon?.message ?? "This coupon cannot be applied", "COUPON_INVALID");
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: view.coupon.code } });
}

export async function removeCoupon(cart: CartRef) {
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
}
