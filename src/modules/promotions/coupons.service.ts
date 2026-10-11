import { z } from "zod";
import { Prisma, type Coupon } from "@prisma/client";
import { prisma, withTransaction, type Db } from "../../database/prisma";
import { conflict, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { audit, type AuditContext } from "../audit/audit.service";

export const couponSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "3-30 letters, digits, - or _"),
    description: z.string().trim().max(300).nullable().optional(),
    discountType: z.enum(["PERCENTAGE", "FIXED"]),
    value: z.number().int().positive(),
    minOrderAmount: z.number().int().min(0).nullable().optional(),
    maxDiscountAmount: z.number().int().positive().nullable().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    usageLimit: z.number().int().positive().nullable().optional(),
    perUserLimit: z.number().int().positive().nullable().optional(),
    scope: z.enum(["ALL", "PRODUCTS", "CATEGORIES"]).default("ALL"),
    channel: z.enum(["ALL", "ONLINE", "POS"]).default("ALL"),
    isActive: z.boolean().default(true),
    isPublic: z.boolean().default(false),
    productIds: z.array(z.uuid()).max(1000).default([]),
    categoryIds: z.array(z.uuid()).max(200).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.discountType === "PERCENTAGE" && c.value > 10_000) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage cannot exceed 100%" });
    if (c.startsAt && c.expiresAt && c.expiresAt <= c.startsAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must be after start" });
    if (c.scope === "PRODUCTS" && !c.productIds.length) ctx.addIssue({ code: "custom", path: ["productIds"], message: "Select at least one product" });
    if (c.scope === "CATEGORIES" && !c.categoryIds.length) ctx.addIssue({ code: "custom", path: ["categoryIds"], message: "Select at least one category" });
  });

export type CouponWithTargets = Coupon & { products: { productId: string }[]; categories: { categoryId: string }[] };

export function findCoupon(db: Db, code: string): Promise<CouponWithTargets | null> {
  return db.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { products: { select: { productId: true } }, categories: { select: { categoryId: true } } },
  });
}

/** Redemptions that count against limits (pending orders hold their use). */
export async function redemptionCounts(db: Db, couponId: string, userId: string | null | undefined) {
  const [total, mine] = await Promise.all([
    db.couponRedemption.count({ where: { couponId, status: { in: ["ACTIVE", "CONFIRMED"] } } }),
    userId ? db.couponRedemption.count({ where: { couponId, userId, status: { in: ["ACTIVE", "CONFIRMED"] } } }) : Promise.resolve(0),
  ]);
  return { total, mine };
}

async function save(id: string | null, input: z.infer<typeof couponSchema>, ctx: AuditContext) {
  const clash = await prisma.coupon.findFirst({ where: { code: input.code, id: id ? { not: id } : undefined }, select: { id: true } });
  if (clash) throw conflict("A coupon with this code already exists");
  const before = id ? await prisma.coupon.findUnique({ where: { id } }) : null;
  if (id && !before) throw notFound("Coupon");
  const saved = await withTransaction(async (tx) => {
    const { productIds, categoryIds, ...fields } = input;
    const data = { ...fields, description: fields.description ?? null, minOrderAmount: fields.minOrderAmount ?? null, maxDiscountAmount: fields.maxDiscountAmount ?? null, startsAt: fields.startsAt ?? null, expiresAt: fields.expiresAt ?? null, usageLimit: fields.usageLimit ?? null, perUserLimit: fields.perUserLimit ?? null };
    const c = id ? await tx.coupon.update({ where: { id }, data }) : await tx.coupon.create({ data });
    await tx.couponProduct.deleteMany({ where: { couponId: c.id } });
    await tx.couponCategory.deleteMany({ where: { couponId: c.id } });
    if (input.scope === "PRODUCTS") await tx.couponProduct.createMany({ data: productIds.map((productId) => ({ couponId: c.id, productId })) });
    if (input.scope === "CATEGORIES") await tx.couponCategory.createMany({ data: categoryIds.map((categoryId) => ({ couponId: c.id, categoryId })) });
    await audit(tx, ctx, { action: id ? "coupon.update" : "coupon.create", entityType: "coupon", entityId: c.id, oldValue: before, newValue: input });
    return c;
  });
  return getCoupon(saved.id);
}

export const createCoupon = (input: z.infer<typeof couponSchema>, ctx: AuditContext) => save(null, input, ctx);
export const updateCoupon = (id: string, input: z.infer<typeof couponSchema>, ctx: AuditContext) => save(id, input, ctx);

export async function deleteCoupon(id: string, ctx: AuditContext) {
  const c = await prisma.coupon.findUnique({ where: { id }, include: { _count: { select: { redemptions: true } } } });
  if (!c) throw notFound("Coupon");
  await withTransaction(async (tx) => {
    if (c._count.redemptions > 0) {
      // Keep history: a used coupon is deactivated, not deleted.
      await tx.coupon.update({ where: { id }, data: { isActive: false } });
    } else {
      await tx.coupon.delete({ where: { id } });
    }
    await audit(tx, ctx, { action: c._count.redemptions > 0 ? "coupon.deactivate" : "coupon.delete", entityType: "coupon", entityId: id, oldValue: c });
  });
  return { deleted: c._count.redemptions === 0, deactivated: c._count.redemptions > 0 };
}

export async function getCoupon(id: string) {
  const c = await prisma.coupon.findUnique({
    where: { id },
    include: {
      products: { include: { product: { select: { id: true, name: true } } } },
      categories: { include: { category: { select: { id: true, name: true } } } },
    },
  });
  if (!c) throw notFound("Coupon");
  const { total } = await redemptionCounts(prisma, id, null);
  return { ...c, redemptions: total };
}

export async function listCoupons(filter: { q?: string; active?: boolean }, page: Pagination) {
  const where: Prisma.CouponWhereInput = { isActive: filter.active, code: filter.q ? { contains: filter.q } : undefined };
  const [items, total] = await Promise.all([
    prisma.coupon.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page) }),
    prisma.coupon.count({ where }),
  ]);
  const counts = await prisma.couponRedemption.groupBy({ by: ["couponId"], where: { couponId: { in: items.map((i) => i.id) }, status: { in: ["ACTIVE", "CONFIRMED"] } }, _count: true });
  return { items: items.map((c) => ({ ...c, redemptions: counts.find((x) => x.couponId === c.id)?._count ?? 0 })), meta: pageMeta(page, total) };
}

/** Public coupons for the storefront "Offers" page. */
export function publicCoupons() {
  const now = new Date();
  return prisma.coupon.findMany({
    where: {
      isActive: true,
      isPublic: true,
      channel: { in: ["ALL", "ONLINE"] },
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    orderBy: { createdAt: "desc" },
    select: { code: true, description: true, discountType: true, value: true, minOrderAmount: true, maxDiscountAmount: true, expiresAt: true },
  });
}
