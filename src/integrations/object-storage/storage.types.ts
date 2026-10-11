/**
 * Where the application's images are kept. Two services are supported and one
 * is chosen with STORAGE_PROVIDER:
 *
 *   r2          Cloudflare R2 through its S3-compatible API (locally: the MinIO container)
 *   cloudinary  Cloudinary, which also resizes and re-encodes the images itself
 *
 * The rest of the application names an image by a storage key and never talks
 * to either service directly.
 *
 * Key layout
 *   uploads/...  a file as it was uploaded (product photos, before the sizes are made)
 *   public/...   a file the storefront shows as it is (category, brand and content pictures;
 *                on R2 also the sizes made from a product photo)
 */

/** How the browser hands a file straight to the storage service (it never passes through the API). */
export interface UploadTicket {
  uploadUrl: string;
  method: "PUT" | "POST";
  /** PUT: request headers; the file is the request body. */
  headers: Record<string, string>;
  /** POST: fields of a multipart form, followed by the file in a field named `file`. */
  fields?: Record<string, string>;
}

export interface StoredObject {
  size: number;
  contentType: string | null;
}

/** One resized copy of a picture: no side longer than `width` pixels, never enlarged. */
export interface RenditionSpec {
  width: number;
  format: "webp" | "avif";
}

export interface Rendition {
  /** The storage key to delete when this copy is no longer needed. */
  key: string;
  url: string;
  width: number;
  height: number;
}

export interface ObjectStorage {
  readonly provider: "r2" | "cloudinary";
  /**
   * Whether an upload ticket holds the browser to the size it declared. R2 does
   * (the size is signed into the ticket). Cloudinary cannot, so there a picture's
   * real size is checked once it is stored (modules/media/upload-limit.ts).
   */
  readonly enforcesUploadSize: boolean;
  /** A one-time permission for the browser to upload one file under `key`. */
  uploadTicket(key: string, contentType: string, contentLength: number): Promise<UploadTicket>;
  put(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Null when nothing is stored under `key`. */
  head(key: string): Promise<StoredObject | null>;
  /** Keys that are not there are skipped. */
  delete(keys: string[]): Promise<void>;
  /** The address the storefront shows a `public/...` picture from. */
  publicUrl(key: string): string;
  /**
   * Resized copies of an uploaded picture, made by the storage service from
   * the stored original (which must then be kept). One entry per spec, in the
   * same order; null where the service could not make that copy. A service
   * without this (R2) leaves the resizing to the worker.
   */
  renditions?(key: string, specs: RenditionSpec[]): Promise<(Rendition | null)[]>;
}

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];
/**
 * The largest file any upload accepts: one rule for every picture in the
 * application (product photos, category images, brand logos, content pictures).
 * The admin shows and checks the same limit before sending a file
 * (MAX_IMAGE_BYTES in the web repository, src/lib/upload.ts).
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
