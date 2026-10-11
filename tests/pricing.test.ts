import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { invalidate } from "../src/database/redis";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import { priceLines } from "../src/modules/pricing/pricing.service";
import { createCoupon } from "../src/modules/promotions/coupons.service";
import { createDiscount } from "../src/modules/promotions/discounts.service";
import { SETTINGS_CACHE_KEY, updateSetting } from "../src/modules/settings/settings.service";
import { allocate, inclusiveTax } from "../src/common/utils/money";
import { resetDatabase } from "./helpers";
import { makeProduct } from "./fixtures";

beforeEach(async () => {
  await resetDatabase();
  await invalidate("tax:classes", "promotions:discounts:active", SETTINGS_CACHE_KEY);
});
afterAll(closeQueues);

const opts = { channel: "ONLINE" as const, includeShipping: true };

describe("money helpers", () => {
  it("allocates without losing a paisa", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1001, [500, 300, 200]).reduce((a, b) => a + b, 0)).toBe(1001);
    expect(inclusiveTax(105000, 500)).toBe(5000);
  });
});

describe("GST", () => {
  it("splits CGST/SGST intra-state and uses IGST inter-state (tax-inclusive prices)", async () => {
    const { variant } = await makeProduct({ price: 79900, stock: 10 });
    const intra = await priceLines([{ variantId: variant.id, quantity: 2 }], { ...opts, placeOfSupply: "33" });
    const line = intra.lines[0]!;
    expect(line.taxRateBps).toBe(500); // apparel slab ≤ ₹2,500
    expect(line.taxAmount).toBe(inclusiveTax(159800, 500));
    expect(line.taxableAmount + line.taxAmount).toBe(159800);
    expect(line.cgstAmount + line.sgstAmount).toBe(line.taxAmount);
    expect(line.igstAmount).toBe(0);
    expect(intra.interState).toBe(false);

    const inter = await priceLines([{ variantId: variant.id, quantity: 2 }], { ...opts, placeOfSupply: "29" });
    expect(inter.lines[0]).toMatchObject({ cgstAmount: 0, sgstAmount: 0, igstAmount: line.taxAmount });
    expect(inter.interState).toBe(true);
  });

  it("chooses the slab from the taxable value per piece", async () => {
    const { variant } = await makeProduct({ price: 300000, stock: 5 }); // ₹3,000 incl. tax
    const q = await priceLines([{ variantId: variant.id, quantity: 1 }], opts);
    expect(q.lines[0]!.taxRateBps).toBe(1800);
    const { variant: cheap } = await makeProduct({ price: 262500, stock: 5 }); // ₹2,625 incl. 5% = ₹2,500 taxable
    expect((await priceLines([{ variantId: cheap.id, quantity: 1 }], opts)).lines[0]!.taxRateBps).toBe(500);
  });

  it("adds tax on top when prices exclude tax", async () => {
    await updateSetting("pricing", { pricesIncludeTax: false, roundGrandTotal: false }, systemContext);
    const { variant } = await makeProduct({ price: 100000, stock: 5, taxClass: "GST_18" });
    const q = await priceLines([{ variantId: variant.id, quantity: 1 }], { ...opts, includeShipping: false });
    expect(q.lines[0]).toMatchObject({ taxableAmount: 100000, taxAmount: 18000, lineTotal: 118000 });
    expect(q.grandTotal).toBe(118000);
  });
});

describe("discounts, coupons and shipping", () => {
  it("applies the best automatic discount, then a coupon, then free shipping", async () => {
    const a = await makeProduct({ price: 60000, mrp: 80000, stock: 10 });
    const b = await makeProduct({ price: 40000, stock: 10 });
    await createDiscount(
      { name: "Weekend 25%", discountType: "PERCENTAGE", value: 2500, scope: "PRODUCTS", channel: "ALL", isActive: true, priority: 0, productIds: [a.product.id], categoryIds: [], brandIds: [] },
      systemContext,
    );
    await createDiscount(
      { name: "₹50 off", discountType: "FIXED", value: 5000, scope: "ALL", channel: "ALL", isActive: true, priority: 0, productIds: [], categoryIds: [], brandIds: [] },
      systemContext,
    );
    await createCoupon(
      { code: "SAVE10", discountType: "PERCENTAGE", value: 1000, maxDiscountAmount: 7000, minOrderAmount: 50000, scope: "ALL", channel: "ALL", isActive: true, isPublic: false, productIds: [], categoryIds: [] },
      systemContext,
    );

    const lines = [
      { variantId: a.variant.id, quantity: 1 },
      { variantId: b.variant.id, quantity: 2 },
    ];
    const q = await priceLines(lines, { ...opts, couponCode: "save10" });
    const [la, lb] = q.lines;
    expect(la!.autoDiscount).toBe(15000); // 25% beats ₹50
    expect(la!.autoDiscountName).toBe("Weekend 25%");
    expect(lb!.autoDiscount).toBe(10000); // ₹50 × 2
    // Coupon base = 45000 + 70000 = 115000 → 10% = 11500 → capped at 7000.
    expect(q.coupon).toMatchObject({ code: "SAVE10", valid: true, discount: 7000 });
    expect(la!.couponDiscount + lb!.couponDiscount).toBe(7000);
    expect(q.discountTotal).toBe(15000 + 10000 + 7000);
    // 108000 of goods ≥ ₹999 free-shipping threshold.
    expect(q.shipping).toMatchObject({ amount: 0, free: true });
    expect(q.grandTotal).toBe(140000 - 32000);
  });

  it("charges flat shipping below the threshold and explains invalid coupons", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 5 });
    await createCoupon(
      { code: "BIG", discountType: "FIXED", value: 10000, minOrderAmount: 200000, scope: "ALL", channel: "ALL", isActive: true, isPublic: true, productIds: [], categoryIds: [] },
      systemContext,
    );
    const q = await priceLines([{ variantId: variant.id, quantity: 1 }], { ...opts, couponCode: "BIG" });
    expect(q.shipping).toMatchObject({ amount: 4900, free: false, amountToFreeShipping: 99900 - 50000 });
    expect(q.grandTotal).toBe(54900);
    expect(q.coupon).toMatchObject({ valid: false, discount: 0 });
    expect(q.coupon!.message).toMatch(/Add items worth/);

    const unknown = await priceLines([{ variantId: variant.id, quantity: 1 }], { ...opts, couponCode: "NOPE" });
    expect(unknown.coupon).toMatchObject({ valid: false, message: "This coupon code is not valid" });
  });

  it("ignores unpurchasable lines in totals", async () => {
    const { variant, product } = await makeProduct({ price: 50000, stock: 5 });
    await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVED" } });
    const q = await priceLines([{ variantId: variant.id, quantity: 1 }], opts);
    expect(q.lines[0]!.purchasable).toBe(false);
    expect(q.grandTotal).toBe(0);
  });
});
