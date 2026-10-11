import { z } from "zod";
import { richText } from "../../common/utils/html";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { cached, invalidate } from "../../database/redis";
import { badRequest, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { audit, type AuditContext } from "../audit/audit.service";

const CACHE_KEY = "promotions:discounts:active";

export const discountSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: richText(500),
    discountType: z.enum(["PERCENTAGE", "FIXED"]),
    value: z.number().int().positive(), // bps or paise
    scope: z.enum(["ALL", "PRODUCTS", "CATEGORIES", "BRANDS"]).default("ALL"),
    channel: z.enum(["ALL", "ONLINE", "POS"]).default("ALL"),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    isActive: z.boolean().default(true),
    priority: z.number().int().min(0).max(1000).default(0),
    productIds: z.array(z.uuid()).max(1000).default([]),
    categoryIds: z.array(z.uuid()).max(200).default([]),
    brandIds: z.array(z.uuid()).max(200).default([]),
  })
  .superRefine((d, ctx) => {
    if (d.discountType === "PERCENTAGE" && d.value > 9000) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage discounts are capped at 90%" });
    if (d.startsAt && d.endsAt && d.endsAt <= d.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start" });
    const targets = { PRODUCTS: d.productIds, CATEGORIES: d.categoryIds, BRANDS: d.brandIds }[d.scope as "PRODUCTS"];
    if (d.scope !== "ALL" && !targets?.length) ctx.addIssue({ code: "custom", path: ["scope"], message: `Select at least one ${d.scope.toLowerCase().slice(0, -1)}` });
  });

export interface ActiveDiscount {
  id: string;
  name: string;
  discountType: "PERCENTAGE" | "FIXED";
  value: number;
  scope: "ALL" | "PRODUCTS" | "CATEGORIES" | "BRANDS";
  channel: "ALL" | "ONLINE" | "POS";
  startsAt: string | null;
  endsAt: string | null;
  priority: number;
  productIds: string[];
  categoryIds: string[];
  brandIds: string[];
}

/** Active (or scheduled) discounts; date windows are checked at use time. */
export function activeDiscounts(): Promise<ActiveDiscount[]> {
  return cached(CACHE_KEY, 60, async () => {
    const rows = await prisma.discount.findMany({
      where: { isActive: true, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      include: { targets: true },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      discountType: d.discountType,
      value: d.value,
      scope: d.scope,
      channel: d.channel,
      startsAt: d.startsAt?.toISOString() ?? null,
      endsAt: d.endsAt?.toISOString() ?? null,
      priority: d.priority,
      productIds: d.targets.flatMap((t) => (t.productId ? [t.productId] : [])),
      categoryIds: d.targets.flatMap((t) => (t.categoryId ? [t.categoryId] : [])),
      brandIds: d.targets.flatMap((t) => (t.brandId ? [t.brandId] : [])),
    }));
  });
}

async function save(id: string | null, input: z.infer<typeof discountSchema>, ctx: AuditContext) {
  const before = id ? await prisma.discount.findUnique({ where: { id }, include: { targets: true } }) : null;
  if (id && !before) throw notFound("Discount");
  const saved = await withTransaction(async (tx) => {
    const data = {
      name: input.name,
      description: input.description ?? null,
      discountType: input.discountType,
      value: input.value,
      scope: input.scope,
      channel: input.channel,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      isActive: input.isActive,
      priority: input.priority,
    };
    const d = id ? await tx.discount.update({ where: { id }, data }) : await tx.discount.create({ data });
    await tx.discountTarget.deleteMany({ where: { discountId: d.id } });
    const targets =
      input.scope === "PRODUCTS"
        ? input.productIds.map((productId) => ({ discountId: d.id, productId }))
        : input.scope === "CATEGORIES"
          ? input.categoryIds.map((categoryId) => ({ discountId: d.id, categoryId }))
          : input.scope === "BRANDS"
            ? input.brandIds.map((brandId) => ({ discountId: d.id, brandId }))
            : [];
    if (targets.length) await tx.discountTarget.createMany({ data: targets });
    await audit(tx, ctx, { action: id ? "discount.update" : "discount.create", entityType: "discount", entityId: d.id, oldValue: before, newValue: input });
    return d;
  });
  await invalidate(CACHE_KEY);
  return getDiscount(saved.id);
}

export const createDiscount = (input: z.infer<typeof discountSchema>, ctx: AuditContext) => save(null, input, ctx);
export const updateDiscount = (id: string, input: z.infer<typeof discountSchema>, ctx: AuditContext) => save(id, input, ctx);

export async function deleteDiscount(id: string, ctx: AuditContext) {
  const before = await prisma.discount.findUnique({ where: { id } });
  if (!before) throw notFound("Discount");
  await withTransaction(async (tx) => {
    await tx.discount.delete({ where: { id } });
    await audit(tx, ctx, { action: "discount.delete", entityType: "discount", entityId: id, oldValue: before });
  });
  await invalidate(CACHE_KEY);
}

export async function getDiscount(id: string) {
  const d = await prisma.discount.findUnique({
    where: { id },
    include: { targets: { include: { product: { select: { id: true, name: true } }, category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } } },
  });
  if (!d) throw notFound("Discount");
  return d;
}

export async function listDiscounts(filter: { active?: boolean }, page: Pagination) {
  const where: Prisma.DiscountWhereInput = { isActive: filter.active };
  const [items, total] = await Promise.all([
    prisma.discount.findMany({ where, orderBy: [{ isActive: "desc" }, { createdAt: "desc" }], ...pageArgs(page), include: { _count: { select: { targets: true } } } }),
    prisma.discount.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export function assertPositive(value: number) {
  if (value <= 0) throw badRequest("Value must be positive");
}
