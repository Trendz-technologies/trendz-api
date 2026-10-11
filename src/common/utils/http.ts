import type { Response } from "express";
import { z } from "zod";

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ok<T>(res: Response, data: T, meta?: PageMeta | Record<string, unknown>, status = 200) {
  return res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, undefined, 201);
}

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function pageArgs(p: Pagination) {
  return { skip: (p.page - 1) * p.limit, take: p.limit };
}

export function pageMeta(p: Pagination, total: number): PageMeta {
  return { page: p.page, limit: p.limit, total, totalPages: Math.max(1, Math.ceil(total / p.limit)) };
}

export const uuidParam = z.object({ id: z.uuid() });

/** Optional boolean from a query string ("true"/"false"/"1"/"0"). */
export const queryBool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

/** Trimmed string; empty strings become undefined (useful for optional query params). */
export const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === "" ? undefined : v));
