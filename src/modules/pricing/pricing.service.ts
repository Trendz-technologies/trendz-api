import { AppError } from "../../common/errors/app-error";
import { allocate, applyBps, inclusiveTax, roundHalfUp } from "../../common/utils/money";
import { prisma, type Db } from "../../database/prisma";
import { imageView } from "../media/image-view";
import { findCoupon, redemptionCounts, type CouponWithTargets } from "../promotions/coupons.service";
import { activeDiscounts, type ActiveDiscount } from "../promotions/discounts.service";
import { getSettings } from "../settings/settings.service";
import { resolveRateBps, taxClassFor } from "../tax/tax.service";

/**
 * The single pricing engine for cart, checkout, orders and POS.
 *
 * Inputs are only variant ids and quantities (plus a coupon code and, for the
 * POS, permission-checked manual discounts). Every price, discount, tax and
 * shipping amount is read from the database and computed here — nothing the
 * client sends is trusted.
 *
 * Order of operations per line:
 *   gross        = selling price × qty
 *   auto         = best single automatic discount (no stacking)
 *   coupon       = order coupon, allocated across eligible lines by value
 *   manual       = POS manual discount (line + bill level, allocated)
 *   net          = gross − auto − coupon − manual
 *   tax          = GST on net (inclusive or exclusive per settings), split
 *                  CGST+SGST (intra-state) or IGST (inter-state)
 */

export interface PricingLineInput {
  variantId: string;
  quantity: number;
  /** POS only: manual discount for the whole line, in paise. */
  manualDiscount?: number;
}

export interface PricingOptions {
  channel: "ONLINE" | "POS";
  couponCode?: string | null;
  userId?: string | null;
  /** GST state code of the place of supply (delivery state). Defaults to the seller's state. */
  placeOfSupply?: string | null;
  /** Override the seller state (e.g. a POS warehouse with its own registration). */
  sellerStateCode?: string | null;
  includeShipping: boolean;
  /** POS only: bill-level manual discount in paise. */
  billDiscount?: number;
  /** Courier rate (paise) when shipping.mode = PROVIDER_RATES; replaces the flat rate. */
  shippingRate?: number | null;
  db?: Db;
  at?: Date;
}

export interface PricedLine {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  variantTitle: string;
  slug: string;
  hsnCode: string | null;
  imageUrl: string | null;
  categoryId: string;
  quantity: number;
  mrp: number;
  unitPrice: number;
  gross: number;
  autoDiscount: number;
  autoDiscountName: string | null;
  couponDiscount: number;
  manualDiscount: number;
  discountAmount: number;
  taxableAmount: number;
  taxRateBps: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  lineTotal: number;
  purchasable: boolean;
  issue: string | null;
}

export interface CouponResult {
  code: string;
  valid: boolean;
  message: string | null;
  discount: number;
  couponId: string | null;
}

export interface Quote {
  lines: PricedLine[];
  itemCount: number;
  subtotal: number;
  discountTotal: number;
  autoDiscountTotal: number;
  couponDiscountTotal: number;
  manualDiscountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  taxTotal: number;
  shipping: { amount: number; taxAmount: number; taxRateBps: number; total: number; free: boolean; freeShippingThreshold: number | null; amountToFreeShipping: number };
  roundOff: number;
  grandTotal: number;
  coupon: CouponResult | null;
  pricesIncludeTax: boolean;
  sellerStateCode: string;
  placeOfSupply: string;
  interState: boolean;
  savings: number;
}

function discountApplies(d: ActiveDiscount, line: { productId: string; categoryPath: string; brandId: string | null }, channel: "ONLINE" | "POS", at: Date) {
  if (d.channel !== "ALL" && d.channel !== channel) return false;
  if (d.startsAt && new Date(d.startsAt) > at) return false;
  if (d.endsAt && new Date(d.endsAt) <= at) return false;
  switch (d.scope) {
    case "ALL":
      return true;
    case "PRODUCTS":
      return d.productIds.includes(line.productId);
    case "CATEGORIES":
      return d.categoryIds.some((c) => line.categoryPath.includes(`/${c}/`)); // category or any ancestor
    case "BRANDS":
      return !!line.brandId && d.brandIds.includes(line.brandId);
  }
}

function perUnitDiscount(d: { discountType: "PERCENTAGE" | "FIXED"; value: number }, unitPrice: number) {
  return Math.min(unitPrice, d.discountType === "PERCENTAGE" ? applyBps(unitPrice, d.value) : d.value);
}

function splitTax(tax: number, interState: boolean) {
  if (interState) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.floor(tax / 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

interface CouponCheck {
  coupon: CouponWithTargets | null;
  invalid: string | null;
}

async function checkCoupon(db: Db, code: string, channel: "ONLINE" | "POS", userId: string | null | undefined, at: Date): Promise<CouponCheck> {
  const coupon = await findCoupon(db, code);
  if (!coupon || !coupon.isActive) return { coupon: null, invalid: "This coupon code is not valid" };
  if (coupon.channel !== "ALL" && coupon.channel !== channel) return { coupon, invalid: `This coupon is only valid ${coupon.channel === "POS" ? "in store" : "online"}` };
  if (coupon.startsAt && coupon.startsAt > at) return { coupon, invalid: "This coupon is not active yet" };
  if (coupon.expiresAt && coupon.expiresAt <= at) return { coupon, invalid: "This coupon has expired" };
  if (coupon.perUserLimit && !userId && channel === "ONLINE") return { coupon, invalid: "Sign in to use this coupon" };
  const { total, mine } = await redemptionCounts(db, coupon.id, userId);
  if (coupon.usageLimit != null && total >= coupon.usageLimit) return { coupon, invalid: "This coupon has reached its usage limit" };
  if (coupon.perUserLimit != null && userId && mine >= coupon.perUserLimit) return { coupon, invalid: "You have already used this coupon" };
  return { coupon, invalid: null };
}

export async function priceLines(inputs: PricingLineInput[], opts: PricingOptions): Promise<Quote> {
  const db = opts.db ?? prisma;
  const at = opts.at ?? new Date();
  const settings = await getSettings();
  const pricesIncludeTax = settings.pricing.pricesIncludeTax;
  const sellerStateCode = opts.sellerStateCode ?? settings.store.address.stateCode;
  const placeOfSupply = opts.placeOfSupply ?? sellerStateCode;
  const interState = placeOfSupply !== sellerStateCode;

  // Merge duplicate variants (quantities add up).
  const merged = new Map<string, PricingLineInput>();
  for (const l of inputs) {
    const prev = merged.get(l.variantId);
    merged.set(l.variantId, prev ? { ...prev, quantity: prev.quantity + l.quantity, manualDiscount: (prev.manualDiscount ?? 0) + (l.manualDiscount ?? 0) } : { ...l });
  }
  const lineInputs = [...merged.values()].filter((l) => l.quantity > 0);

  const variants = await db.productVariant.findMany({
    where: { id: { in: lineInputs.map((l) => l.variantId) } },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          taxClassId: true,
          hsnCode: true,
          brandId: true,
          categoryId: true,
          category: { select: { path: true, isActive: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1 },
        },
      },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const discounts = await activeDiscounts();

  // Step 1: gross + best automatic discount.
  const lines: PricedLine[] = [];
  for (const input of lineInputs) {
    const v = byId.get(input.variantId);
    if (!v) throw new AppError(404, "NOT_FOUND", "A product in your cart no longer exists");
    const p = v.product;
    const purchasable = v.status === "ACTIVE" && p.status === "ACTIVE" && (opts.channel === "POS" || p.category.isActive);
    const unitPrice = v.sellingPrice;
    const gross = unitPrice * input.quantity;
    let best: { d: ActiveDiscount; perUnit: number } | null = null;
    for (const d of discounts) {
      if (!discountApplies(d, { productId: p.id, categoryPath: p.category.path, brandId: p.brandId }, opts.channel, at)) continue;
      const perUnit = perUnitDiscount(d, unitPrice);
      if (!best || perUnit > best.perUnit || (perUnit === best.perUnit && d.priority > best.d.priority)) best = { d, perUnit };
    }
    const autoDiscount = best ? best.perUnit * input.quantity : 0;
    lines.push({
      variantId: v.id,
      productId: p.id,
      sku: v.sku,
      name: p.name,
      variantTitle: v.title,
      slug: p.slug,
      hsnCode: p.hsnCode,
      imageUrl: p.images[0] ? imageView(p.images[0]).thumb : null,
      categoryId: p.categoryId,
      quantity: input.quantity,
      mrp: v.mrp,
      unitPrice,
      gross,
      autoDiscount,
      autoDiscountName: best?.d.name ?? null,
      couponDiscount: 0,
      manualDiscount: Math.min(Math.max(0, input.manualDiscount ?? 0), gross - autoDiscount),
      discountAmount: 0,
      taxableAmount: 0,
      taxRateBps: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      taxAmount: 0,
      lineTotal: 0,
      purchasable,
      issue: purchasable ? null : "This item is no longer available",
    });
  }

  // Step 2: coupon.
  let coupon: CouponResult | null = null;
  if (opts.couponCode) {
    const code = opts.couponCode.trim().toUpperCase();
    const check = await checkCoupon(db, code, opts.channel, opts.userId, at);
    coupon = { code, valid: false, message: check.invalid, discount: 0, couponId: check.coupon?.id ?? null };
    if (!check.invalid && check.coupon) {
      const c = check.coupon;
      const productIds = new Set(c.products.map((x) => x.productId));
      const eligible = lines.filter((l) => {
        if (!l.purchasable) return false;
        if (!settings.coupons.allowWithAutomaticDiscounts && l.autoDiscount > 0) return false;
        if (c.scope === "PRODUCTS") return productIds.has(l.productId);
        if (c.scope === "CATEGORIES") {
          const path = byId.get(l.variantId)!.product.category.path;
          return c.categories.some((cat) => path.includes(`/${cat.categoryId}/`));
        }
        return true;
      });
      const eligibleBase = eligible.reduce((s, l) => s + l.gross - l.autoDiscount, 0);
      if (eligible.length === 0 || eligibleBase <= 0) {
        coupon.message = "This coupon does not apply to the items in your cart";
      } else if (c.minOrderAmount != null && eligibleBase < c.minOrderAmount) {
        coupon.message = `Add items worth ₹${((c.minOrderAmount - eligibleBase) / 100).toFixed(2)} more to use this coupon`;
      } else {
        let amount = c.discountType === "PERCENTAGE" ? applyBps(eligibleBase, c.value) : c.value;
        if (c.maxDiscountAmount != null) amount = Math.min(amount, c.maxDiscountAmount);
        amount = Math.min(amount, eligibleBase);
        const parts = allocate(amount, eligible.map((l) => l.gross - l.autoDiscount));
        eligible.forEach((l, i) => (l.couponDiscount = parts[i]!));
        coupon.valid = true;
        coupon.discount = amount;
        coupon.message = null;
      }
    }
  }

  // Step 3: bill-level manual discount (POS), allocated over remaining value.
  if (opts.billDiscount && opts.billDiscount > 0) {
    const remaining = lines.map((l) => Math.max(0, l.gross - l.autoDiscount - l.couponDiscount - l.manualDiscount));
    const total = remaining.reduce((a, b) => a + b, 0);
    const parts = allocate(Math.min(opts.billDiscount, total), remaining);
    lines.forEach((l, i) => (l.manualDiscount += parts[i]!));
  }

  // Step 4: tax per line.
  for (const l of lines) {
    const v = byId.get(l.variantId)!;
    l.discountAmount = l.autoDiscount + l.couponDiscount + l.manualDiscount;
    const net = Math.max(0, l.gross - l.discountAmount);
    const netUnit = roundHalfUp(net / l.quantity);
    l.taxRateBps = resolveRateBps(await taxClassFor(v.product.taxClassId), netUnit, pricesIncludeTax, at);
    if (pricesIncludeTax) {
      l.taxAmount = inclusiveTax(net, l.taxRateBps);
      l.taxableAmount = net - l.taxAmount;
      l.lineTotal = net;
    } else {
      l.taxableAmount = net;
      l.taxAmount = applyBps(net, l.taxRateBps);
      l.lineTotal = net + l.taxAmount;
    }
    const split = splitTax(l.taxAmount, interState);
    l.cgstAmount = split.cgst;
    l.sgstAmount = split.sgst;
    l.igstAmount = split.igst;
  }

  const sellable = lines.filter((l) => l.purchasable);
  const merchandise = sellable.reduce((s, l) => s + l.lineTotal, 0);

  // Step 5: shipping (online only).
  const sh = settings.shipping;
  let shippingAmount = 0;
  let free = false;
  if (opts.includeShipping && sellable.length > 0) {
    free = sh.freeShippingThreshold != null && merchandise >= sh.freeShippingThreshold;
    shippingAmount = free ? 0 : (opts.shippingRate ?? sh.flatRate);
  }
  let shippingTax = 0;
  let shippingTotal = shippingAmount;
  if (shippingAmount > 0 && sh.chargeTaxable && sh.taxRateBps > 0) {
    if (pricesIncludeTax) shippingTax = inclusiveTax(shippingAmount, sh.taxRateBps);
    else {
      shippingTax = applyBps(shippingAmount, sh.taxRateBps);
      shippingTotal = shippingAmount + shippingTax;
    }
  }
  const shippingSplit = splitTax(shippingTax, interState);

  const sum = (f: (l: PricedLine) => number) => sellable.reduce((s, l) => s + f(l), 0);
  const beforeRound = merchandise + shippingTotal;
  const grandTotal = settings.pricing.roundGrandTotal ? Math.round(beforeRound / 100) * 100 : beforeRound;
  const discountTotal = sum((l) => l.discountAmount);

  return {
    lines,
    itemCount: sum((l) => l.quantity),
    subtotal: sum((l) => l.gross),
    discountTotal,
    autoDiscountTotal: sum((l) => l.autoDiscount),
    couponDiscountTotal: sum((l) => l.couponDiscount),
    manualDiscountTotal: sum((l) => l.manualDiscount),
    taxableTotal: sum((l) => l.taxableAmount) + (shippingTotal - shippingTax),
    cgstTotal: sum((l) => l.cgstAmount) + shippingSplit.cgst,
    sgstTotal: sum((l) => l.sgstAmount) + shippingSplit.sgst,
    igstTotal: sum((l) => l.igstAmount) + shippingSplit.igst,
    taxTotal: sum((l) => l.taxAmount) + shippingTax,
    shipping: {
      amount: shippingAmount,
      taxAmount: shippingTax,
      taxRateBps: shippingTax > 0 ? sh.taxRateBps : 0,
      total: shippingTotal,
      free,
      freeShippingThreshold: sh.freeShippingThreshold,
      amountToFreeShipping: sh.freeShippingThreshold != null ? Math.max(0, sh.freeShippingThreshold - merchandise) : 0,
    },
    roundOff: grandTotal - beforeRound,
    grandTotal,
    coupon,
    pricesIncludeTax,
    sellerStateCode,
    placeOfSupply,
    interState,
    savings: sum((l) => (l.mrp - l.unitPrice) * l.quantity) + discountTotal,
  };
}

/** Display price for listings: selling price after the best automatic discount. */
export async function displayPrices(items: { productId: string; categoryPath: string; brandId: string | null; sellingPrice: number }[], channel: "ONLINE" | "POS" = "ONLINE") {
  const discounts = await activeDiscounts();
  const now = new Date();
  return items.map((i) => {
    let best = 0;
    for (const d of discounts) if (discountApplies(d, i, channel, now)) best = Math.max(best, perUnitDiscount(d, i.sellingPrice));
    return i.sellingPrice - best;
  });
}
