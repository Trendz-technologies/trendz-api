import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { invalidate } from "../../database/redis";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors/app-error";
import { sanitizeRichText } from "../../common/utils/html";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { uniqueSlug } from "../../common/utils/slug";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { audit, type AuditContext } from "../audit/audit.service";
import { availabilityByVariant } from "../inventory/availability";
import { imageKeys, imageView } from "../media/image-view";
import { getSetting } from "../settings/settings.service";
import { descendantIds } from "./categories.service";
import type { ProductInput, productListQuery, VariantInput } from "./products.schemas";

export const productCacheKey = (slug: string) => `catalog:product:${slug}`;

const variantTitle = (input: ProductInput, v: VariantInput) =>
  input.options.length ? input.options.map((o) => v.options[o.name]).join(" / ") : "Default";

/** The "from" price shown on listings: the cheapest active variant. */
function fromPrice(variants: { mrp: number; sellingPrice: number; status: string }[]) {
  const pool = variants.filter((v) => v.status === "ACTIVE");
  const list = pool.length ? pool : variants;
  const cheapest = list.reduce((a, b) => (b.sellingPrice < a.sellingPrice ? b : a));
  return { mrp: cheapest.mrp, sellingPrice: cheapest.sellingPrice };
}

async function assertReferences(input: ProductInput) {
  const [category, brand, taxClass] = await Promise.all([
    prisma.category.findUnique({ where: { id: input.categoryId }, select: { id: true } }),
    input.brandId ? prisma.brand.findUnique({ where: { id: input.brandId }, select: { id: true } }) : null,
    input.taxClassId ? prisma.taxClass.findUnique({ where: { id: input.taxClassId }, select: { id: true } }) : null,
  ]);
  if (!category) throw badRequest("Category not found", "VALIDATION_ERROR", [{ path: "categoryId", message: "Category not found" }]);
  if (input.brandId && !brand) throw badRequest("Brand not found", "VALIDATION_ERROR", [{ path: "brandId", message: "Brand not found" }]);
  if (input.taxClassId && !taxClass) throw badRequest("Tax class not found", "VALIDATION_ERROR", [{ path: "taxClassId", message: "Tax class not found" }]);
}

/** SKUs must be unique across the whole catalog (variants and product base SKUs). */
async function assertSkusAvailable(input: ProductInput, productId: string | null) {
  const skus = input.variants.map((v) => v.sku);
  const [variantClash, baseClash] = await Promise.all([
    prisma.productVariant.findMany({
      where: { sku: { in: skus }, productId: productId ? { not: productId } : undefined },
      select: { sku: true },
    }),
    prisma.product.findFirst({ where: { baseSku: input.baseSku, id: productId ? { not: productId } : undefined }, select: { id: true } }),
  ]);
  if (variantClash.length) {
    throw conflict(`SKU already in use: ${variantClash.map((v) => v.sku).join(", ")}`, "DUPLICATE_SKU");
  }
  if (baseClash) throw conflict(`Base SKU ${input.baseSku} is already used by another product`, "DUPLICATE_SKU");
}

/** Recreates options/values and links every variant to its values. */
async function writeOptions(tx: Tx, productId: string, input: ProductInput, variants: { id: string; sku: string }[]) {
  await tx.productOption.deleteMany({ where: { productId } }); // cascades to values + variant links
  const valueIds = new Map<string, string>(); // "Size\0M" -> id
  for (const [position, o] of input.options.entries()) {
    const option = await tx.productOption.create({
      data: { productId, name: o.name, position, values: { create: o.values.map((value, i) => ({ value, position: i })) } },
      include: { values: true },
    });
    for (const v of option.values) valueIds.set(`${o.name}\u0000${v.value}`, v.id);
  }
  const links: { variantId: string; optionValueId: string }[] = [];
  for (const v of input.variants) {
    const variantId = variants.find((x) => x.sku === v.sku)!.id;
    for (const o of input.options) links.push({ variantId, optionValueId: valueIds.get(`${o.name}\u0000${v.options[o.name]}`)! });
  }
  if (links.length) await tx.variantOptionValue.createMany({ data: links });
}

function productData(input: ProductInput) {
  return {
    name: input.name,
    baseSku: input.baseSku,
    description: sanitizeRichText(input.description),
    shortDescription: sanitizeRichText(input.shortDescription),
    categoryId: input.categoryId,
    brandId: input.brandId ?? null,
    productType: input.productType ?? null,
    status: input.status,
    taxClassId: input.taxClassId ?? null,
    hsnCode: input.hsnCode ?? null,
    minStockLevel: input.minStockLevel,
    weightGrams: input.weightGrams ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    heightMm: input.heightMm ?? null,
    tags: [...new Set(input.tags)],
    isFeatured: input.isFeatured,
    seoTitle: input.seoTitle ?? null,
    seoDescription: input.seoDescription ?? null,
    seoKeywords: input.seoKeywords ?? null,
    ...fromPrice(input.variants),
  };
}

function variantData(input: ProductInput, v: VariantInput, position: number, isDefault: boolean) {
  return {
    sku: v.sku,
    title: variantTitle(input, v),
    mrp: v.mrp,
    sellingPrice: v.sellingPrice,
    costPrice: v.costPrice ?? null,
    weightGrams: v.weightGrams ?? null,
    lengthMm: v.lengthMm ?? null,
    widthMm: v.widthMm ?? null,
    heightMm: v.heightMm ?? null,
    lowStockThreshold: v.lowStockThreshold ?? null,
    status: v.status,
    isDefault,
    position,
  };
}

const defaultIndex = (input: ProductInput) => Math.max(0, input.variants.findIndex((v) => v.isDefault));

export async function createProduct(input: ProductInput, ctx: AuditContext) {
  await assertReferences(input);
  await assertSkusAvailable(input, null);
  const slugExists = async (s: string) => !!(await prisma.product.findUnique({ where: { slug: s }, select: { id: true } }));
  if (input.slug && (await slugExists(input.slug))) throw conflict("This URL slug is already used by another product");
  const slug = input.slug ?? (await uniqueSlug(input.name, slugExists));
  const def = defaultIndex(input);

  const id = await withTransaction(async (tx) => {
    const product = await tx.product.create({
      data: { ...productData(input), slug, publishedAt: input.status === "ACTIVE" ? new Date() : null },
    });
    const variants: { id: string; sku: string }[] = [];
    for (const [i, v] of input.variants.entries()) {
      variants.push(await tx.productVariant.create({ data: { ...variantData(input, v, i, i === def), productId: product.id }, select: { id: true, sku: true } }));
    }
    await writeOptions(tx, product.id, input, variants);
    await audit(tx, ctx, { action: "product.create", entityType: "product", entityId: product.id, newValue: { ...input, slug } });
    return product.id;
  });
  return getProduct(id);
}

/** A variant can only be deleted if nothing in the business history refers to it. */
async function variantIsReferenced(tx: Tx, variantId: string) {
  const [orders, ledger, purchases, transfers, pos] = await Promise.all([
    tx.orderItem.count({ where: { variantId } }),
    tx.inventoryTransaction.count({ where: { variantId } }),
    tx.purchaseOrderItem.count({ where: { variantId } }),
    tx.stockTransferItem.count({ where: { variantId } }),
    tx.posCartItem.count({ where: { variantId } }),
  ]);
  return orders + ledger + purchases + transfers + pos > 0;
}

export async function updateProduct(id: string, input: ProductInput, ctx: AuditContext, permissions: readonly string[]) {
  const before = await prisma.product.findUnique({ where: { id }, include: { variants: true, options: { include: { values: true } } } });
  if (!before) throw notFound("Product");
  await assertReferences(input);
  await assertSkusAvailable(input, id);
  if (input.slug && input.slug !== before.slug) {
    const taken = await prisma.product.findFirst({ where: { slug: input.slug, id: { not: id } }, select: { id: true } });
    if (taken) throw conflict("This URL slug is already used by another product");
  }

  // Match input variants to existing ones by id, then by SKU.
  const byId = new Map(before.variants.map((v) => [v.id, v]));
  const bySku = new Map(before.variants.map((v) => [v.sku, v]));
  const matched = input.variants.map((v) => {
    if (v.id) {
      const existing = byId.get(v.id);
      if (!existing) throw badRequest(`Variant ${v.id} does not belong to this product`);
      return existing;
    }
    return bySku.get(v.sku) ?? null;
  });
  const skuChanges = input.variants
    .map((v, i) => ({ from: matched[i]?.sku, to: v.sku, variantId: matched[i]?.id }))
    .filter((c) => c.from && c.from !== c.to);
  if (skuChanges.length && !permissions.includes("codes.manage")) {
    throw forbidden("Changing a SKU requires the codes.manage permission");
  }
  const def = defaultIndex(input);

  await withTransaction(async (tx) => {
    // Free SKUs that are being renamed first to avoid transient unique clashes.
    for (const c of skuChanges) await tx.productVariant.update({ where: { id: c.variantId! }, data: { sku: `__tmp_${c.variantId}` } });

    const kept: { id: string; sku: string }[] = [];
    for (const [i, v] of input.variants.entries()) {
      const existing = matched[i];
      const data = variantData(input, v, i, i === def);
      if (existing) {
        await tx.productVariant.update({ where: { id: existing.id }, data });
        kept.push({ id: existing.id, sku: v.sku });
      } else {
        kept.push(await tx.productVariant.create({ data: { ...data, productId: id }, select: { id: true, sku: true } }));
      }
    }
    for (const c of skuChanges) {
      await tx.productCode.updateMany({ where: { variantId: c.variantId! }, data: { sku: c.to } });
    }

    // Variants dropped from the form: delete if unused, otherwise discontinue.
    const keptIds = new Set(kept.map((k) => k.id));
    for (const old of before.variants.filter((v) => !keptIds.has(v.id))) {
      if (await variantIsReferenced(tx, old.id)) {
        await tx.productVariant.update({ where: { id: old.id }, data: { status: "DISCONTINUED", isDefault: false } });
      } else {
        await tx.inventoryLevel.deleteMany({ where: { variantId: old.id } });
        await tx.productVariant.delete({ where: { id: old.id } });
      }
    }

    await writeOptions(tx, id, input, kept);
    await tx.product.update({
      where: { id },
      data: {
        ...productData(input),
        slug: input.slug ?? before.slug,
        publishedAt: input.status === "ACTIVE" ? (before.publishedAt ?? new Date()) : before.publishedAt,
      },
    });
    await audit(tx, ctx, {
      action: "product.update",
      entityType: "product",
      entityId: id,
      oldValue: { ...before, options: before.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.value) })) },
      newValue: input,
    });
    for (const c of skuChanges) {
      await audit(tx, ctx, { action: "variant.sku_change", entityType: "product_variant", entityId: c.variantId!, oldValue: c.from, newValue: c.to });
    }
  });
  await invalidate(productCacheKey(before.slug), productCacheKey(input.slug ?? before.slug));
  return getProduct(id);
}

export async function deleteProduct(id: string, ctx: AuditContext): Promise<{ deleted: boolean; archived: boolean }> {
  const product = await prisma.product.findUnique({ where: { id }, include: { variants: { select: { id: true } }, images: true } });
  if (!product) throw notFound("Product");

  const result = await withTransaction(async (tx) => {
    const referenced = (await Promise.all(product.variants.map((v) => variantIsReferenced(tx, v.id)))).some(Boolean);
    if (referenced) {
      // Business history must stay intact: archive instead of deleting.
      await tx.product.update({ where: { id }, data: { status: "ARCHIVED" } });
      await audit(tx, ctx, { action: "product.archive", entityType: "product", entityId: id, oldValue: { status: product.status }, newValue: { status: "ARCHIVED" } });
      return { deleted: false, archived: true };
    }
    await tx.inventoryLevel.deleteMany({ where: { variantId: { in: product.variants.map((v) => v.id) } } });
    await tx.product.delete({ where: { id } });
    await audit(tx, ctx, { action: "product.delete", entityType: "product", entityId: id, oldValue: { name: product.name, baseSku: product.baseSku } });
    return { deleted: true, archived: false };
  });

  if (result.deleted && product.images.length) {
    await enqueue(QUEUE_NAMES.media, "image.delete-objects", { keys: product.images.flatMap(imageKeys) });
  }
  await invalidate(productCacheKey(product.slug));
  return result;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const detailInclude = {
  category: { select: { id: true, name: true, slug: true } },
  brand: { select: { id: true, name: true, slug: true } },
  taxClass: { select: { id: true, code: true, name: true } },
  options: { orderBy: { position: "asc" }, include: { values: { orderBy: { position: "asc" } } } },
  variants: {
    orderBy: { position: "asc" },
    include: { optionValues: { include: { optionValue: { include: { option: true } } } } },
  },
  images: { orderBy: { sortOrder: "asc" } },
  codes: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.ProductInclude;

type ProductDetail = Prisma.ProductGetPayload<{ include: typeof detailInclude }>;

export function variantOptions(v: ProductDetail["variants"][number]): Record<string, string> {
  return Object.fromEntries(v.optionValues.map((ov) => [ov.optionValue.option.name, ov.optionValue.value]));
}

export async function getProduct(id: string) {
  const p = await prisma.product.findUnique({ where: { id }, include: detailInclude });
  if (!p) throw notFound("Product");
  const [stock, perWarehouse] = await Promise.all([
    availabilityByVariant(p.variants.map((v) => v.id), await allWarehouseIds()),
    prisma.inventoryLevel.findMany({
      where: { variantId: { in: p.variants.map((v) => v.id) } },
      select: { variantId: true, onHand: true, reserved: true, damaged: true, warehouse: { select: { id: true, code: true, name: true } } },
    }),
  ]);
  const inventory = await getSetting("inventory");
  return {
    ...p,
    options: p.options.map((o) => ({ id: o.id, name: o.name, values: o.values.map((v) => v.value) })),
    images: p.images.map(imageView),
    variants: p.variants.map((v) => {
      const { optionValues: _ov, ...rest } = v;
      const s = stock.get(v.id)!;
      return {
        ...rest,
        options: variantOptions(v),
        stock: {
          ...s,
          lowStockThreshold: v.lowStockThreshold ?? (p.minStockLevel || inventory.defaultLowStockThreshold),
          warehouses: perWarehouse
            .filter((w) => w.variantId === v.id)
            .map((w) => ({ ...w.warehouse, onHand: w.onHand, reserved: w.reserved, damaged: w.damaged, available: w.onHand - w.reserved })),
        },
      };
    }),
  };
}

async function allWarehouseIds() {
  return (await prisma.warehouse.findMany({ select: { id: true } })).map((w) => w.id);
}

export async function listProducts(query: z.infer<typeof productListQuery>, page: Pagination) {
  const where: Prisma.ProductWhereInput = {
    status: query.status,
    brandId: query.brandId,
    categoryId: query.categoryId ? { in: await descendantIds(query.categoryId) } : undefined,
    OR: query.q
      ? [
          { name: { contains: query.q, mode: "insensitive" } },
          { baseSku: { startsWith: query.q.toUpperCase() } },
          { variants: { some: { sku: { contains: query.q.toUpperCase() } } } },
          { tags: { has: query.q.toLowerCase() } },
        ]
      : undefined,
  };

  if (query.stock) {
    // Stock filters need per-variant arithmetic; resolve the matching product ids in SQL.
    const rows = await prisma.$queryRaw<{ product_id: string }[]>`
      SELECT v.product_id
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN inventory_levels il ON il.variant_id = v.id
      GROUP BY v.id, v.product_id, v.low_stock_threshold, p.min_stock_level
      HAVING ${
        query.stock === "out"
          ? Prisma.sql`COALESCE(SUM(il.on_hand - il.reserved), 0) <= 0`
          : query.stock === "low"
            ? Prisma.sql`COALESCE(SUM(il.on_hand - il.reserved), 0) > 0 AND COALESCE(SUM(il.on_hand - il.reserved), 0) <= COALESCE(v.low_stock_threshold, NULLIF(p.min_stock_level, 0), 5)`
            : Prisma.sql`COALESCE(SUM(il.on_hand - il.reserved), 0) > 0`
      }`;
    where.id = { in: [...new Set(rows.map((r) => r.product_id))] };
  }

  const orderBy: Prisma.ProductOrderByWithRelationInput =
    {
      newest: { createdAt: "desc" as const },
      oldest: { createdAt: "asc" as const },
      name: { name: "asc" as const },
      price_asc: { sellingPrice: "asc" as const },
      price_desc: { sellingPrice: "desc" as const },
      updated: { updatedAt: "desc" as const },
    }[query.sort];

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      ...pageArgs(page),
      select: {
        id: true,
        name: true,
        slug: true,
        baseSku: true,
        status: true,
        mrp: true,
        sellingPrice: true,
        isFeatured: true,
        updatedAt: true,
        createdAt: true,
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
        variants: { select: { id: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const stock = await availabilityByVariant(items.flatMap((p) => p.variants.map((v) => v.id)), await allWarehouseIds());
  return {
    items: items.map(({ images, variants, ...p }) => ({
      ...p,
      image: images[0] ? imageView(images[0]) : null,
      variantCount: variants.length,
      available: variants.reduce((sum, v) => sum + (stock.get(v.id)?.available ?? 0), 0),
    })),
    meta: pageMeta(page, total),
  };
}

