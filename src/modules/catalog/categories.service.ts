import { z } from "zod";
import { richText } from "../../common/utils/html";
import type { Category } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { cached, invalidate } from "../../database/redis";
import { badRequest, conflict, notFound } from "../../common/errors/app-error";
import { slugSchemaPattern, uniqueSlug } from "../../common/utils/slug";
import { audit, type AuditContext } from "../audit/audit.service";
import { storage } from "../../integrations/object-storage";
import { checkAttachedImages } from "../media/upload-limit";

export const MAX_CATEGORY_DEPTH = 3; // 0 = root, so up to 4 levels

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().toLowerCase().regex(slugSchemaPattern, "Use lowercase letters, numbers and hyphens").max(80).optional(),
  parentId: z.uuid().nullable().optional(),
  description: richText(2000),
  imageKey: z.string().regex(/^public\/categories\/[\w.-]+$/, "Upload the image through /api/uploads/presign").nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  seoTitle: z.string().trim().max(70).nullable().optional(),
  seoDescription: z.string().trim().max(170).nullable().optional(),
  seoKeywords: z.string().trim().max(300).nullable().optional(),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export const reorderSchema = z.object({ parentId: z.uuid().nullable(), orderedIds: z.array(z.uuid()).min(1).max(500) });

export const TREE_CACHE_KEY = "catalog:categories:tree";
export const invalidateCategoryCache = () => invalidate(TREE_CACHE_KEY);

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  depth: number;
  parentId: string | null;
  productCount?: number;
  children: CategoryNode[];
}

function buildTree(rows: (Category & { productCount?: number })[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      name: r.name,
      slug: r.slug,
      imageUrl: r.imageUrl,
      description: r.description,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      depth: r.depth,
      parentId: r.parentId,
      productCount: r.productCount,
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else if (!node.parentId) roots.push(node);
  }
  const sort = (list: CategoryNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Admin tree: every category, with product counts. */
export async function adminTree() {
  const [rows, counts] = await Promise.all([
    prisma.category.findMany(),
    prisma.product.groupBy({ by: ["categoryId"], _count: { _all: true } }),
  ]);
  const byCategory = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  return buildTree(rows.map((r) => ({ ...r, productCount: byCategory.get(r.id) ?? 0 })));
}

/** Storefront tree: active categories whose ancestors are all active. Cached. */
export function publicTree() {
  return cached(TREE_CACHE_KEY, 300, async () => {
    const rows = await prisma.category.findMany({ where: { isActive: true } });
    return buildTree(rows); // children of inactive parents are dropped by buildTree
  });
}

export async function getCategory(id: string) {
  const c = await prisma.category.findUnique({ where: { id } });
  if (!c) throw notFound("Category");
  return c;
}

const slugTaken = (excludeId?: string) => async (slug: string) =>
  !!(await prisma.category.findFirst({ where: { slug, id: excludeId ? { not: excludeId } : undefined }, select: { id: true } }));

async function resolveParent(parentId: string | null | undefined) {
  if (!parentId) return null;
  const parent = await prisma.category.findUnique({ where: { id: parentId } });
  if (!parent) throw badRequest("Parent category not found");
  if (parent.depth >= MAX_CATEGORY_DEPTH) throw badRequest(`Categories can be nested at most ${MAX_CATEGORY_DEPTH + 1} levels deep`);
  return parent;
}

function imageUrlFor(key: string | null | undefined) {
  return key ? storage().publicUrl(key) : null;
}

export async function createCategory(input: CategoryInput, ctx: AuditContext) {
  const parent = await resolveParent(input.parentId);
  if (input.slug && (await slugTaken()(input.slug))) throw conflict("This slug is already used by another category");
  const slug = input.slug ?? (await uniqueSlug(input.name, slugTaken()));
  await checkAttachedImages([input.imageKey]);
  const category = await withTransaction(async (tx) => {
    const siblings = await tx.category.count({ where: { parentId: parent?.id ?? null } });
    const created = await tx.category.create({
      data: {
        ...input,
        slug,
        parentId: parent?.id ?? null,
        depth: parent ? parent.depth + 1 : 0,
        imageUrl: imageUrlFor(input.imageKey),
        sortOrder: input.sortOrder ?? siblings,
      },
    });
    const path = `${parent?.path ?? "/"}${created.id}/`;
    const withPath = await tx.category.update({ where: { id: created.id }, data: { path } });
    await audit(tx, ctx, { action: "category.create", entityType: "category", entityId: created.id, newValue: withPath });
    return withPath;
  });
  await invalidateCategoryCache();
  return category;
}

export async function updateCategory(id: string, input: CategoryInput, ctx: AuditContext) {
  const before = await getCategory(id);
  if (input.slug && input.slug !== before.slug && (await slugTaken(id)(input.slug))) {
    throw conflict("This slug is already used by another category");
  }
  const parentChanged = input.parentId !== undefined && (input.parentId ?? null) !== before.parentId;
  const parent = parentChanged ? await resolveParent(input.parentId) : null;
  if (parent && (parent.id === id || parent.path.includes(`/${id}/`))) {
    throw badRequest("A category cannot be moved inside itself or one of its subcategories");
  }
  await checkAttachedImages([input.imageKey], [before.imageKey]);

  const updated = await withTransaction(async (tx) => {
    if (parentChanged) {
      const newPath = `${parent?.path ?? "/"}${id}/`;
      const depthDelta = (parent ? parent.depth + 1 : 0) - before.depth;
      const deepest = await tx.category.aggregate({ where: { path: { startsWith: before.path } }, _max: { depth: true } });
      if ((deepest._max.depth ?? before.depth) + depthDelta > MAX_CATEGORY_DEPTH) {
        throw badRequest(`Moving here would nest categories deeper than ${MAX_CATEGORY_DEPTH + 1} levels`);
      }
      // Re-root the whole subtree in one statement.
      await tx.$executeRaw`
        UPDATE categories
        SET path = ${newPath}::text || substring(path FROM ${before.path.length + 1}::int),
            depth = depth + ${depthDelta}::int
        WHERE path LIKE ${before.path + "%"}::text`;
    }
    const c = await tx.category.update({
      where: { id },
      data: {
        ...input,
        parentId: parentChanged ? (parent?.id ?? null) : undefined,
        imageUrl: input.imageKey !== undefined ? imageUrlFor(input.imageKey) : undefined,
      },
    });
    await audit(tx, ctx, { action: "category.update", entityType: "category", entityId: id, oldValue: before, newValue: c });
    return c;
  });
  await invalidateCategoryCache();
  return updated;
}

export async function deleteCategory(id: string, ctx: AuditContext) {
  const before = await getCategory(id);
  const [children, products] = await Promise.all([
    prisma.category.count({ where: { parentId: id } }),
    prisma.product.count({ where: { categoryId: id } }),
  ]);
  if (children) throw conflict("Move or delete the subcategories first");
  if (products) throw conflict(`${products} product(s) use this category. Move them first, or deactivate the category instead.`);
  await withTransaction(async (tx) => {
    await tx.category.delete({ where: { id } });
    await audit(tx, ctx, { action: "category.delete", entityType: "category", entityId: id, oldValue: before });
  });
  await invalidateCategoryCache();
}

export async function reorderCategories(input: z.infer<typeof reorderSchema>, ctx: AuditContext) {
  const siblings = await prisma.category.findMany({ where: { parentId: input.parentId }, select: { id: true } });
  const siblingIds = new Set(siblings.map((s) => s.id));
  if (input.orderedIds.some((id) => !siblingIds.has(id))) throw badRequest("All categories must share the given parent");
  await withTransaction(async (tx) => {
    for (const [index, id] of input.orderedIds.entries()) {
      await tx.category.update({ where: { id }, data: { sortOrder: index } });
    }
    await audit(tx, ctx, { action: "category.reorder", entityType: "category", entityId: input.parentId, newValue: input.orderedIds });
  });
  await invalidateCategoryCache();
}

/** Ids of a category and all its descendants (for "products in category" queries). */
export async function descendantIds(categoryId: string): Promise<string[]> {
  const c = await prisma.category.findUnique({ where: { id: categoryId }, select: { path: true } });
  if (!c) return [];
  const rows = await prisma.category.findMany({ where: { path: { startsWith: c.path } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Root → leaf chain for breadcrumbs. */
export async function breadcrumb(categoryId: string) {
  const c = await prisma.category.findUnique({ where: { id: categoryId }, select: { path: true } });
  if (!c) return [];
  const ids = c.path.split("/").filter(Boolean);
  const rows = await prisma.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}
