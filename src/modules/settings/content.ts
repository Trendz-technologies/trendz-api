import { z } from "zod";
import { storage } from "../../integrations/object-storage";

/**
 * Building blocks for storefront content that is written in the admin (the
 * home page offers and everything under Admin → CMS).
 */

/** One piece of text in English and Tamil; the storefront falls back to the other language when one is empty. */
export const localizedText = (max: number) => z.object({ en: z.string().trim().max(max).default(""), ta: z.string().trim().max(max).default("") });

/** Links stay inside the shop: a path such as /products or /category/lehenga, or empty for no link. */
export const siteLink = (fallback = "") =>
  z
    .string()
    .trim()
    .max(200)
    .regex(/^(\/(?!\/)\S*)?$/, "Use a path on this site, e.g. /products")
    .default(fallback);

/** Storage key of a picture uploaded through /api/uploads/presign with purpose "content"; null for none. */
export const contentImageKey = z.string().regex(/^public\/content\/[\w.-]+$/, "Upload the image through /api/uploads/presign").nullable().default(null);

// A missing storage URL must not take the page down with it: the block simply shows without its picture.
export function contentImageUrl(key: string | null): string | null {
  if (!key) return null;
  try {
    return storage().publicUrl(key);
  } catch {
    return null;
  }
}
