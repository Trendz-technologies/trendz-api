import { z } from "zod";
import { richText } from "../../common/utils/html";
import { prisma, withTransaction } from "../../database/prisma";
import { cached, invalidate } from "../../database/redis";
import { AppError, badRequest, conflict, notFound } from "../../common/errors/app-error";
import { BPS_DENOMINATOR, roundHalfUp } from "../../common/utils/money";
import { audit, type AuditContext } from "../audit/audit.service";

const CACHE_KEY = "tax:classes";

const rateSchema = z
  .object({
    rateBps: z.number().int().min(0).max(10_000),
    minUnitPrice: z.number().int().min(0).nullable().optional(),
    maxUnitPrice: z.number().int().min(0).nullable().optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
  })
  .refine((r) => r.minUnitPrice == null || r.maxUnitPrice == null || r.minUnitPrice <= r.maxUnitPrice, "minUnitPrice must be ≤ maxUnitPrice");

export const taxClassSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Z0-9_]{2,30}$/, "Use UPPER_SNAKE_CASE"),
    name: z.string().trim().min(2).max(80),
    description: richText(500),
    isDefault: z.boolean().optional(),
    rates: z.array(rateSchema).min(1).max(20),
  })
  .superRefine((c, ctx) => {
    // Slabs that are effective at the same time must not overlap.
    const sorted = [...c.rates].sort((a, b) => (a.minUnitPrice ?? 0) - (b.minUnitPrice ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const sameWindow = (prev.effectiveFrom?.getTime() ?? 0) === (cur.effectiveFrom?.getTime() ?? 0);
      if (sameWindow && (prev.maxUnitPrice == null || (cur.minUnitPrice ?? 0) <= prev.maxUnitPrice)) {
        ctx.addIssue({ code: "custom", path: ["rates"], message: "Price slabs overlap" });
      }
    }
  });

export interface TaxRateRow {
  rateBps: number;
  minUnitPrice: number | null;
  maxUnitPrice: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}
export interface TaxClassRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  rates: TaxRateRow[];
}

export function taxClasses(): Promise<TaxClassRow[]> {
  return cached(CACHE_KEY, 300, async () => {
    const rows = await prisma.taxClass.findMany({ include: { rates: true }, orderBy: { name: "asc" } });
    return rows.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      description: c.description,
      isDefault: c.isDefault,
      rates: c.rates.map((r) => ({
        rateBps: r.rateBps,
        minUnitPrice: r.minUnitPrice,
        maxUnitPrice: r.maxUnitPrice,
        effectiveFrom: r.effectiveFrom.toISOString(),
        effectiveTo: r.effectiveTo?.toISOString() ?? null,
      })),
    }));
  });
}

const inSlab = (r: TaxRateRow, unitTaxable: number) =>
  (r.minUnitPrice == null || unitTaxable >= r.minUnitPrice) && (r.maxUnitPrice == null || unitTaxable <= r.maxUnitPrice);

/**
 * Picks the GST rate for one unit of a product.
 *
 * Slabs are defined on the taxable value per piece. For tax-inclusive prices
 * the taxable value depends on the rate itself, so candidate rates are tried
 * from lowest to highest and the first one whose slab contains the resulting
 * taxable value wins.
 */
export function resolveRateBps(cls: TaxClassRow, unitPrice: number, pricesIncludeTax: boolean, at = new Date()): number {
  const t = at.getTime();
  const active = cls.rates
    .filter((r) => new Date(r.effectiveFrom).getTime() <= t && (!r.effectiveTo || new Date(r.effectiveTo).getTime() > t))
    .sort((a, b) => a.rateBps - b.rateBps);
  if (active.length === 0) {
    throw new AppError(409, "TAX_NOT_CONFIGURED", `Tax class ${cls.code} has no rate effective on ${at.toISOString().slice(0, 10)}`);
  }
  for (const r of active) {
    const taxable = pricesIncludeTax ? roundHalfUp((unitPrice * BPS_DENOMINATOR) / (BPS_DENOMINATOR + r.rateBps)) : unitPrice;
    if (inSlab(r, taxable)) return r.rateBps;
  }
  throw new AppError(409, "TAX_NOT_CONFIGURED", `No ${cls.code} tax slab covers a unit price of ${unitPrice} paise`);
}

/** The tax class for a product, falling back to the default class. */
export async function taxClassFor(taxClassId: string | null): Promise<TaxClassRow> {
  const classes = await taxClasses();
  const cls = (taxClassId && classes.find((c) => c.id === taxClassId)) || classes.find((c) => c.isDefault);
  if (!cls) throw new AppError(409, "TAX_NOT_CONFIGURED", "No tax class is assigned and no default tax class exists. Configure tax in Admin → Settings.");
  return cls;
}

export async function saveTaxClass(id: string | null, input: z.infer<typeof taxClassSchema>, ctx: AuditContext) {
  const clash = await prisma.taxClass.findFirst({ where: { code: input.code, id: id ? { not: id } : undefined } });
  if (clash) throw conflict("A tax class with this code already exists");
  const before = id ? await prisma.taxClass.findUnique({ where: { id }, include: { rates: true } }) : null;
  if (id && !before) throw notFound("Tax class");

  const saved = await withTransaction(async (tx) => {
    if (input.isDefault) await tx.taxClass.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const data = { code: input.code, name: input.name, description: input.description ?? null, isDefault: input.isDefault ?? false };
    const cls = id ? await tx.taxClass.update({ where: { id }, data }) : await tx.taxClass.create({ data });
    await tx.taxRate.deleteMany({ where: { taxClassId: cls.id } });
    await tx.taxRate.createMany({
      data: input.rates.map((r) => ({
        taxClassId: cls.id,
        rateBps: r.rateBps,
        minUnitPrice: r.minUnitPrice ?? null,
        maxUnitPrice: r.maxUnitPrice ?? null,
        effectiveFrom: r.effectiveFrom ?? new Date(),
        effectiveTo: r.effectiveTo ?? null,
      })),
    });
    await audit(tx, ctx, { action: id ? "tax_class.update" : "tax_class.create", entityType: "tax_class", entityId: cls.id, oldValue: before, newValue: input });
    return cls;
  });
  await invalidate(CACHE_KEY);
  return (await taxClasses()).find((c) => c.id === saved.id);
}

export async function deleteTaxClass(id: string, ctx: AuditContext) {
  const cls = await prisma.taxClass.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
  if (!cls) throw notFound("Tax class");
  if (cls._count.products) throw conflict("Products use this tax class. Reassign them first.");
  if (cls.isDefault) throw badRequest("Choose another default tax class first");
  await withTransaction(async (tx) => {
    await tx.taxClass.delete({ where: { id } });
    await audit(tx, ctx, { action: "tax_class.delete", entityType: "tax_class", entityId: id, oldValue: cls });
  });
  await invalidate(CACHE_KEY);
}
