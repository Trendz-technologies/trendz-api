import { Router } from "express";
import { z } from "zod";
import { richText } from "../../common/utils/html";
import { prisma, withTransaction } from "../../database/prisma";
import { cached, invalidate } from "../../database/redis";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { conflict, notFound } from "../../common/errors/app-error";
import { created, ok, uuidParam } from "../../common/utils/http";
import { slugSchemaPattern, uniqueSlug } from "../../common/utils/slug";
import { storage } from "../../integrations/object-storage";
import { audit, auditContext } from "../audit/audit.service";
import { checkAttachedImages } from "../media/upload-limit";

export const brandsRouter = Router();
brandsRouter.use(authenticate, requireStaff);

export const BRANDS_CACHE_KEY = "catalog:brands";
export const publicBrands = () =>
  cached(BRANDS_CACHE_KEY, 300, () =>
    prisma.brand.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true, logoUrl: true } }),
  );

const brandSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().regex(slugSchemaPattern).max(80).optional(),
  description: richText(2000),
  logoKey: z.string().regex(/^public\/brands\/[\w.-]+$/, "Upload the logo through /api/uploads/presign").nullable().optional(),
  isActive: z.boolean().optional(),
});

const slugTaken = (excludeId?: string) => async (slug: string) =>
  !!(await prisma.brand.findFirst({ where: { slug, id: excludeId ? { not: excludeId } : undefined }, select: { id: true } }));

brandsRouter.get("/", requirePermission("brands.read"), async (_req, res) => {
  const brands = await prisma.brand.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
  ok(res, brands.map(({ _count, ...b }) => ({ ...b, productCount: _count.products })));
});

brandsRouter.post("/", requirePermission("brands.write"), async (req, res) => {
  const input = brandSchema.parse(req.body);
  if (input.slug && (await slugTaken()(input.slug))) throw conflict("This slug is already used by another brand");
  const slug = input.slug ?? (await uniqueSlug(input.name, slugTaken()));
  await checkAttachedImages([input.logoKey]);
  const brand = await withTransaction(async (tx) => {
    const b = await tx.brand.create({ data: { ...input, slug, logoUrl: input.logoKey ? storage().publicUrl(input.logoKey) : null } });
    await audit(tx, auditContext(req), { action: "brand.create", entityType: "brand", entityId: b.id, newValue: b });
    return b;
  });
  await invalidate(BRANDS_CACHE_KEY);
  created(res, brand);
});

brandsRouter.put("/:id", requirePermission("brands.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = brandSchema.parse(req.body);
  const before = await prisma.brand.findUnique({ where: { id } });
  if (!before) throw notFound("Brand");
  if (input.slug && input.slug !== before.slug && (await slugTaken(id)(input.slug))) throw conflict("This slug is already used by another brand");
  await checkAttachedImages([input.logoKey], [before.logoKey]);
  const brand = await withTransaction(async (tx) => {
    const b = await tx.brand.update({
      where: { id },
      data: { ...input, logoUrl: input.logoKey !== undefined ? (input.logoKey ? storage().publicUrl(input.logoKey) : null) : undefined },
    });
    await audit(tx, auditContext(req), { action: "brand.update", entityType: "brand", entityId: id, oldValue: before, newValue: b });
    return b;
  });
  await invalidate(BRANDS_CACHE_KEY);
  ok(res, brand);
});

brandsRouter.delete("/:id", requirePermission("brands.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const before = await prisma.brand.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
  if (!before) throw notFound("Brand");
  if (before._count.products) throw conflict(`${before._count.products} product(s) use this brand. Reassign them or deactivate the brand.`);
  await withTransaction(async (tx) => {
    await tx.brand.delete({ where: { id } });
    await audit(tx, auditContext(req), { action: "brand.delete", entityType: "brand", entityId: id, oldValue: before });
  });
  await invalidate(BRANDS_CACHE_KEY);
  ok(res, { deleted: true });
});
