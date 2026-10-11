import { richTextToPlain } from "../../common/utils/html";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database/prisma";
import { cached } from "../../database/redis";
import { notFound } from "../../common/errors/app-error";
import { pageMeta, type Pagination } from "../../common/utils/http";
import { availabilityByVariant, onlineWarehouses } from "../inventory/availability";
import { imageView } from "../media/image-view";
import { breadcrumb, publicTree, type CategoryNode } from "../catalog/categories.service";
import { productCacheKey, variantOptions } from "../catalog/products.service";
import { displayPrices } from "../pricing/pricing.service";

export const listingQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(100).optional(), // slug
  brand: z.string().trim().max(500).optional(), // comma-separated slugs
  minPrice: z.coerce.number().int().min(0).optional(), // paise
  maxPrice: z.coerce.number().int().min(0).optional(),
  inStock: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  featured: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
  sort: z.enum(["relevance", "newest", "price_asc", "price_desc", "name"]).optional(),
});
export type ListingQuery = z.infer<typeof listingQuery>;

/** Parses option filters given as ?opt.Size=M,L&opt.Color=Red */
export function parseOptionFilters(query: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(query)) {
    if (!k.startsWith("opt.") || typeof v !== "string") continue;
    const name = k.slice(4).slice(0, 30);
    const values = v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (name && values.length) out[name] = values;
  }
  return out;
}

function flatten(nodes: CategoryNode[], acc: CategoryNode[] = []): CategoryNode[] {
  for (const n of nodes) {
    acc.push(n);
    flatten(n.children, acc);
  }
  return acc;
}

async function categoryScope(slug?: string): Promise<{ ids: string[]; category: CategoryNode | null }> {
  const all = flatten(await publicTree());
  if (!slug) return { ids: all.map((c) => c.id), category: null };
  const category = all.find((c) => c.slug === slug) ?? null;
  if (!category) throw notFound("Category");
  return { ids: flatten([category]).map((c) => c.id), category };
}

/** WHERE clause shared by listing and facets. */
async function listingWhere(q: ListingQuery, optionFilters: Record<string, string[]>) {
  const { ids } = await categoryScope(q.category);
  const warehouses = (await onlineWarehouses()).map((w) => w.id);
  const parts: Prisma.Sql[] = [Prisma.sql`p.status = 'ACTIVE'`, Prisma.sql`p.category_id = ANY(${ids}::uuid[])`];

  if (q.brand) {
    const slugs = q.brand.split(",").map((s) => s.trim()).filter(Boolean);
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM brands b WHERE b.id = p.brand_id AND b.is_active AND b.slug = ANY(${slugs}))`);
  }
  if (q.minPrice !== undefined) parts.push(Prisma.sql`p.selling_price >= ${q.minPrice}`);
  if (q.maxPrice !== undefined) parts.push(Prisma.sql`p.selling_price <= ${q.maxPrice}`);
  if (q.featured) parts.push(Prisma.sql`p.is_featured`);
  if (q.inStock) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM product_variants v
      JOIN inventory_levels il ON il.variant_id = v.id AND il.warehouse_id = ANY(${warehouses}::uuid[])
      WHERE v.product_id = p.id AND v.status = 'ACTIVE' AND il.on_hand - il.reserved > 0)`);
  }
  for (const [name, values] of Object.entries(optionFilters)) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM product_variants v
      JOIN variant_option_values vov ON vov.variant_id = v.id
      JOIN product_option_values pov ON pov.id = vov.option_value_id
      JOIN product_options po ON po.id = pov.option_id
      WHERE v.product_id = p.id AND v.status = 'ACTIVE' AND lower(po.name) = lower(${name}) AND pov.value = ANY(${values}))`);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const prefix = `${q.q.toUpperCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    parts.push(Prisma.sql`(
      p.name ILIKE ${like}
      OR p.base_sku LIKE ${prefix}
      OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku LIKE ${prefix})
      OR ${q.q.toLowerCase()} = ANY(p.tags)
      OR word_similarity(${q.q}, p.name) > 0.45)`);
  }
  return Prisma.join(parts, " AND ");
}

export interface ProductCard {
  id: string;
  name: string;
  slug: string;
  brand: { name: string; slug: string } | null;
  category: { name: string; slug: string };
  mrp: number;
  sellingPrice: number;
  discountPercent: number;
  inStock: boolean;
  isFeatured: boolean;
  image: ReturnType<typeof imageView> | null;
  hoverImage: ReturnType<typeof imageView> | null;
  options: { name: string; values: string[] }[];
}

const cardSelect = {
  id: true,
  name: true,
  slug: true,
  mrp: true,
  sellingPrice: true,
  isFeatured: true,
  brandId: true,
  brand: { select: { name: true, slug: true } },
  category: { select: { name: true, slug: true, path: true } },
  images: { where: { url: { not: null } }, orderBy: { sortOrder: "asc" }, take: 2 },
  options: { orderBy: { position: "asc" }, select: { name: true, values: { orderBy: { position: "asc" }, select: { value: true } } } },
  variants: { where: { status: "ACTIVE" }, select: { id: true } },
} satisfies Prisma.ProductSelect;

async function hydrateCards(ids: string[]): Promise<ProductCard[]> {
  if (!ids.length) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: cardSelect });
  const stock = await availabilityByVariant(rows.flatMap((r) => r.variants.map((v) => v.id)));
  // Automatic discounts are applied to the displayed price.
  const prices = await displayPrices(rows.map((r) => ({ productId: r.id, categoryPath: r.category.path, brandId: r.brandId, sellingPrice: r.sellingPrice })));
  const priceOf = new Map(rows.map((r, i) => [r.id, prices[i]!]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      brand: r.brand,
      category: { name: r.category.name, slug: r.category.slug },
      mrp: r.mrp,
      sellingPrice: priceOf.get(r.id)!,
      discountPercent: r.mrp > priceOf.get(r.id)! ? Math.round(((r.mrp - priceOf.get(r.id)!) / r.mrp) * 100) : 0,
      inStock: r.variants.some((v) => (stock.get(v.id)?.available ?? 0) > 0),
      isFeatured: r.isFeatured,
      image: r.images[0] ? imageView(r.images[0]) : null,
      hoverImage: r.images[1] ? imageView(r.images[1]) : null,
      options: r.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.value) })),
    }));
}

export async function listProducts(q: ListingQuery, optionFilters: Record<string, string[]>, page: Pagination) {
  const where = await listingWhere(q, optionFilters);
  const sort = q.sort ?? (q.q ? "relevance" : "newest");
  const orderBy = {
    relevance: q.q
      ? Prisma.sql`GREATEST(similarity(p.name, ${q.q}), word_similarity(${q.q}, p.name)) DESC, p.created_at DESC`
      : Prisma.sql`p.is_featured DESC, p.created_at DESC`,
    newest: Prisma.sql`p.published_at DESC NULLS LAST, p.created_at DESC`,
    price_asc: Prisma.sql`p.selling_price ASC, p.created_at DESC`,
    price_desc: Prisma.sql`p.selling_price DESC, p.created_at DESC`,
    name: Prisma.sql`p.name ASC`,
  }[sort];

  const rows = await prisma.$queryRaw<{ id: string; total: bigint }[]>`
    SELECT p.id, COUNT(*) OVER() AS total
    FROM products p
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ${page.limit} OFFSET ${(page.page - 1) * page.limit}`;

  // COUNT(*) OVER() is empty when the page is past the end; count separately then.
  const total = rows.length
    ? Number(rows[0]!.total)
    : Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM products p WHERE ${where}`)[0]!.n);
  return { items: await hydrateCards(rows.map((r) => r.id)), meta: pageMeta(page, total) };
}

export async function facets(q: ListingQuery, optionFilters: Record<string, string[]>) {
  const where = await listingWhere(q, optionFilters);
  const [brands, price, options] = await Promise.all([
    prisma.$queryRaw<{ name: string; slug: string; count: bigint }[]>`
      SELECT b.name, b.slug, COUNT(*) AS count
      FROM products p JOIN brands b ON b.id = p.brand_id AND b.is_active
      WHERE ${where}
      GROUP BY b.name, b.slug ORDER BY b.name`,
    prisma.$queryRaw<{ min: number | null; max: number | null }[]>`
      SELECT MIN(p.selling_price) AS min, MAX(p.selling_price) AS max FROM products p WHERE ${where}`,
    prisma.$queryRaw<{ name: string; value: string; count: bigint }[]>`
      SELECT po.name, pov.value, COUNT(DISTINCT p.id) AS count
      FROM products p
      JOIN product_options po ON po.product_id = p.id
      JOIN product_option_values pov ON pov.option_id = po.id
      WHERE ${where}
      GROUP BY po.name, pov.value ORDER BY po.name, MIN(pov.position), pov.value`,
  ]);
  const grouped = new Map<string, { value: string; count: number }[]>();
  for (const o of options) {
    const list = grouped.get(o.name) ?? [];
    list.push({ value: o.value, count: Number(o.count) });
    grouped.set(o.name, list);
  }
  return {
    brands: brands.map((b) => ({ name: b.name, slug: b.slug, count: Number(b.count) })),
    price: { min: price[0]?.min ?? 0, max: price[0]?.max ?? 0 },
    options: [...grouped.entries()].map(([name, values]) => ({ name, values })),
  };
}

export async function suggest(term: string) {
  const { items } = await listProducts({ q: term, inStock: false, featured: false }, {}, { page: 1, limit: 8 });
  return items.map((p) => ({ name: p.name, slug: p.slug, sellingPrice: p.sellingPrice, image: p.image?.thumb ?? null }));
}

/** Product detail. The catalog part is cached; stock is always read fresh. */
export async function productDetail(slug: string) {
  const base = await cached(productCacheKey(slug), 60, async () => {
    const p = await prisma.product.findFirst({
      where: { slug, status: "ACTIVE", category: { isActive: true } },
      include: {
        brand: { select: { name: true, slug: true } },
        category: { select: { id: true, name: true, slug: true, path: true } },
        options: { orderBy: { position: "asc" }, include: { values: { orderBy: { position: "asc" } } } },
        variants: {
          where: { status: { in: ["ACTIVE", "INACTIVE"] } },
          orderBy: { position: "asc" },
          include: { optionValues: { include: { optionValue: { include: { option: true } } } } },
        },
        images: { where: { url: { not: null } }, orderBy: { sortOrder: "asc" } },
      },
    });
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      baseSku: p.baseSku,
      description: p.description,
      shortDescription: p.shortDescription,
      productType: p.productType,
      brand: p.brand,
      brandId: p.brandId,
      category: { id: p.category.id, name: p.category.name, slug: p.category.slug },
      categoryPath: p.category.path,
      breadcrumb: await breadcrumb(p.category.id),
      hsnCode: p.hsnCode,
      tags: p.tags,
      mrp: p.mrp,
      sellingPrice: p.sellingPrice,
      seo: { title: p.seoTitle ?? p.name, description: p.seoDescription ?? richTextToPlain(p.shortDescription), keywords: p.seoKeywords },
      options: p.options.map((o) => ({ name: o.name, values: o.values.map((v) => v.value) })),
      images: p.images.map(imageView),
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        title: v.title,
        options: variantOptions(v),
        mrp: v.mrp,
        sellingPrice: v.sellingPrice,
        isDefault: v.isDefault,
        purchasable: v.status === "ACTIVE",
        weightGrams: v.weightGrams ?? p.weightGrams,
      })),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
  if (!base) throw notFound("Product");

  const [stock, related, prices] = await Promise.all([
    availabilityByVariant(base.variants.map((v) => v.id)),
    relatedProducts(base.id, base.category.id),
    displayPrices(base.variants.map((v) => ({ productId: base.id, categoryPath: base.categoryPath, brandId: base.brandId, sellingPrice: v.sellingPrice }))),
  ]);
  const { categoryPath: _path, brandId: _brand, ...publicBase } = base;
  return {
    ...publicBase,
    sellingPrice: Math.min(...prices),
    variants: base.variants.map((v, i) => {
      const available = stock.get(v.id)?.available ?? 0;
      // Exact counts are not exposed publicly; only a "few left" hint.
      return { ...v, sellingPrice: prices[i]!, inStock: v.purchasable && available > 0, lowStock: v.purchasable && available > 0 && available <= 5 };
    }),
    related,
  };
}

async function relatedProducts(productId: string, categoryId: string) {
  const rows = await prisma.product.findMany({
    where: { categoryId, status: "ACTIVE", id: { not: productId } },
    orderBy: [{ isFeatured: "desc" }, { createdAt: "desc" }],
    take: 8,
    select: { id: true },
  });
  return hydrateCards(rows.map((r) => r.id));
}

export async function categoryDetail(slug: string) {
  const { category } = await categoryScope(slug);
  const row = await prisma.category.findUnique({
    where: { id: category!.id },
    select: { id: true, name: true, slug: true, description: true, imageUrl: true, seoTitle: true, seoDescription: true, seoKeywords: true },
  });
  return { ...row!, children: category!.children, breadcrumb: await breadcrumb(category!.id) };
}

export async function sitemapEntries() {
  const [products, categories] = await Promise.all([
    prisma.product.findMany({ where: { status: "ACTIVE" }, select: { slug: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 50_000 }),
    publicTree().then((t) => flatten(t)),
  ]);
  return {
    products: products.map((p) => ({ slug: p.slug, updatedAt: p.updatedAt.toISOString() })),
    categories: categories.map((c) => ({ slug: c.slug })),
  };
}
