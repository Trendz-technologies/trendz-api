import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { invalidate } from "../../database/redis";
import { badRequest, notFound } from "../../common/errors/app-error";
import { logger } from "../../config/logger";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, storage, type ObjectStorage } from "../../integrations/object-storage";
import { audit, type AuditContext } from "../audit/audit.service";
import { IMAGE_SIZES, imageKeys, imageView, type ImageSizes } from "./image-view";
import { IMAGE_TOO_LARGE, refuseIfOversized } from "./upload-limit";

export const MAX_IMAGES_PER_PRODUCT = 30;

export const uploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
  size: z.number().int().positive().max(MAX_IMAGE_BYTES, IMAGE_TOO_LARGE),
  variantId: z.uuid().nullable().optional(),
  altText: z.string().trim().max(200).nullable().optional(),
});

export const imageUpdateSchema = z.object({
  altText: z.string().trim().max(200).nullable().optional(),
  variantId: z.uuid().nullable().optional(),
});

export const reorderSchema = z.object({ imageIds: z.array(z.uuid()).min(1).max(MAX_IMAGES_PER_PRODUCT) });

async function productSlug(productId: string) {
  const p = await prisma.product.findUnique({ where: { id: productId }, select: { slug: true } });
  if (!p) throw notFound("Product");
  return p.slug;
}

async function assertVariant(productId: string, variantId: string | null | undefined) {
  if (!variantId) return;
  const v = await prisma.productVariant.findFirst({ where: { id: variantId, productId }, select: { id: true } });
  if (!v) throw badRequest("Variant does not belong to this product");
}

async function getOwnedImage(productId: string, imageId: string) {
  const img = await prisma.productImage.findFirst({ where: { id: imageId, productId } });
  if (!img) throw notFound("Image");
  return img;
}

const uploadKey = (productId: string, imageId: string) => `uploads/products/${productId}/${imageId}/${Date.now().toString(36)}`;

/** Step 1: create the image record and a ticket for the browser to upload the file straight to image storage. */
export async function requestUpload(productId: string, input: z.infer<typeof uploadRequestSchema>, ctx: AuditContext) {
  await productSlug(productId);
  await assertVariant(productId, input.variantId);
  const count = await prisma.productImage.count({ where: { productId } });
  if (count >= MAX_IMAGES_PER_PRODUCT) throw badRequest(`A product can have at most ${MAX_IMAGES_PER_PRODUCT} images`);

  const id = randomUUID();
  const objectKey = uploadKey(productId, id);
  const image = await withTransaction(async (tx) => {
    const img = await tx.productImage.create({
      data: {
        id,
        productId,
        variantId: input.variantId ?? null,
        objectKey,
        altText: input.altText ?? null,
        sortOrder: count,
        mimeType: input.contentType,
        bytes: input.size,
        status: "PENDING_UPLOAD",
      },
    });
    await audit(tx, ctx, { action: "product.image.upload", entityType: "product", entityId: productId, newValue: { imageId: id, fileName: input.fileName } });
    return img;
  });
  return { image: imageView(image), ...(await storage().uploadTicket(objectKey, input.contentType, input.size)) };
}

/** Step 2: the browser finished uploading; verify and queue processing. */
export async function completeUpload(productId: string, imageId: string) {
  const img = await getOwnedImage(productId, imageId);
  if (img.status !== "PENDING_UPLOAD" && img.status !== "FAILED") return imageView(img);
  const head = await storage().head(img.objectKey);
  if (!head) throw badRequest("The upload has not finished. Upload the file first.", "UPLOAD_MISSING");
  // The ticket was only given for a size within the limit; this is the file that actually arrived.
  await refuseIfOversized(img.objectKey, head.size);
  const updated = await prisma.productImage.update({ where: { id: imageId }, data: { status: "PROCESSING", error: null } });
  await enqueue(QUEUE_NAMES.media, "image.process", { imageId }, { jobId: `img-${imageId}-${img.objectKey.split("/").pop()}` });
  return imageView(updated);
}

/** Replace the file behind an existing image (keeps id, alt text and position). */
export async function requestReplace(productId: string, imageId: string, input: z.infer<typeof uploadRequestSchema>, ctx: AuditContext) {
  const img = await getOwnedImage(productId, imageId);
  const objectKey = uploadKey(productId, imageId);
  // The previous sizes stay live until the new file has been processed.
  const updated = await withTransaction(async (tx) => {
    const u = await tx.productImage.update({
      where: { id: imageId },
      data: { objectKey, status: "PENDING_UPLOAD", mimeType: input.contentType, bytes: input.size, error: null },
    });
    await audit(tx, ctx, { action: "product.image.replace", entityType: "product", entityId: productId, oldValue: { imageId, objectKey: img.objectKey }, newValue: { objectKey } });
    return u;
  });
  return { image: imageView(updated), ...(await storage().uploadTicket(objectKey, input.contentType, input.size)) };
}

export async function updateImage(productId: string, imageId: string, input: z.infer<typeof imageUpdateSchema>) {
  await getOwnedImage(productId, imageId);
  await assertVariant(productId, input.variantId);
  const img = await prisma.productImage.update({ where: { id: imageId }, data: input });
  await invalidate(`catalog:product:${await productSlug(productId)}`);
  return imageView(img);
}

export async function reorderImages(productId: string, imageIds: string[]) {
  const existing = await prisma.productImage.findMany({ where: { productId }, select: { id: true } });
  if (existing.length !== imageIds.length || !existing.every((e) => imageIds.includes(e.id))) {
    throw badRequest("Send every image id of the product exactly once");
  }
  await prisma.$transaction(imageIds.map((id, sortOrder) => prisma.productImage.update({ where: { id }, data: { sortOrder } })));
  await invalidate(`catalog:product:${await productSlug(productId)}`);
}

export async function deleteImage(productId: string, imageId: string, ctx: AuditContext) {
  const img = await getOwnedImage(productId, imageId);
  await withTransaction(async (tx) => {
    await tx.productImage.delete({ where: { id: imageId } });
    const rest = await tx.productImage.findMany({ where: { productId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
    for (const [i, r] of rest.entries()) await tx.productImage.update({ where: { id: r.id }, data: { sortOrder: i } });
    await audit(tx, ctx, { action: "product.image.delete", entityType: "product", entityId: productId, oldValue: { imageId } });
  });
  await enqueue(QUEUE_NAMES.media, "image.delete-objects", { keys: imageKeys(img) });
  await invalidate(`catalog:product:${await productSlug(productId)}`);
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "avif", "heif"]);

/** The sizes the storefront uses: WebP in three sizes, AVIF in two. */
const RENDITIONS: { name: keyof ImageSizes; width: number; format: "webp" | "avif" }[] = [
  { name: "thumb", width: IMAGE_SIZES.thumb, format: "webp" },
  { name: "medium", width: IMAGE_SIZES.medium, format: "webp" },
  { name: "large", width: IMAGE_SIZES.large, format: "webp" },
  { name: "mediumAvif", width: IMAGE_SIZES.medium, format: "avif" },
  { name: "largeAvif", width: IMAGE_SIZES.large, format: "avif" },
];
type ReadySizes = ImageSizes & Required<Pick<ImageSizes, "thumb" | "medium" | "large">>;

/** The sizes made here with sharp and stored under `base` (the storage only keeps files). */
async function renderHere(store: ObjectStorage, objectKey: string, base: string): Promise<ReadySizes> {
  const original = await store.get(objectKey);
  const meta = await sharp(original, { failOn: "error", limitInputPixels: 60_000_000 }).metadata();
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw new Error(`Unsupported image format: ${meta.format ?? "unknown"}`);

  const sizes: ImageSizes = {};
  for (const { name, width, format } of RENDITIONS) {
    const pipeline = sharp(original, { failOn: "error", limitInputPixels: 60_000_000 })
      .rotate() // honour EXIF orientation, then strip metadata
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true });
    const { data, info } = await (format === "webp" ? pipeline.webp({ quality: 80 }) : pipeline.avif({ quality: 50, effort: 4 })).toBuffer({ resolveWithObject: true });
    const key = `${base}/${name}.${format}`;
    await store.put(key, data, `image/${format}`);
    sizes[name] = { key, url: store.publicUrl(key), width: info.width, height: info.height };
  }
  return sizes as ReadySizes;
}

/** The sizes made by the storage service from the stored photo (Cloudinary). */
async function renderInStorage(store: ObjectStorage, objectKey: string): Promise<ReadySizes> {
  const made = await store.renditions!(objectKey, RENDITIONS);
  const sizes: ImageSizes = {};
  RENDITIONS.forEach(({ name }, i) => {
    const size = made[i];
    if (size) sizes[name] = size;
  });
  // The AVIF copies are a bonus (browsers fall back to WebP); the WebP ones are what every page uses.
  if (!sizes.thumb || !sizes.medium || !sizes.large) throw new Error("Image storage did not return every WebP size");
  return sizes as ReadySizes;
}

/**
 * Turns an uploaded photo into the sizes the storefront shows.
 *
 * On R2 the worker makes WebP (3 sizes) and AVIF (2 sizes) files and the
 * upload is deleted. Cloudinary makes the same sizes from the stored photo,
 * which is therefore kept: every size then shares the photo's storage key.
 */
export async function processImage(imageId: string): Promise<void> {
  const img = await prisma.productImage.findUnique({ where: { id: imageId } });
  if (!img || img.status !== "PROCESSING") return;

  const store = storage();
  const keepsOriginal = Boolean(store.renditions);
  const version = img.objectKey.split("/").pop()!;
  const base = `public/products/${img.productId}/${img.id}/${version}`;
  const sizes = keepsOriginal ? await renderInStorage(store, img.objectKey) : await renderHere(store, img.objectKey, base);
  const made = keepsOriginal ? [] : Object.values(sizes).map((s) => s.key);

  // What the image showed before a replacement (never the files of this very upload, when a job runs twice).
  const previousKeys = Object.values((img.sizes ?? {}) as ImageSizes)
    .map((s) => s.key)
    .filter((k) => k !== img.objectKey && !k.startsWith(base));
  const updated = await prisma.productImage.updateMany({
    where: { id: imageId, objectKey: img.objectKey }, // a newer replacement wins
    data: {
      sizes: sizes as unknown as Prisma.InputJsonValue,
      url: sizes.large.url,
      width: sizes.large.width,
      height: sizes.large.height,
      mimeType: "image/webp",
      status: "READY",
      error: null,
    },
  });
  if (!updated.count) {
    // Replaced while this ran: nothing of this upload is wanted any more.
    await store.delete([img.objectKey, ...made]);
  } else {
    // Without a storage service that resizes, only the optimised sizes are kept, never the upload itself.
    await store.delete(keepsOriginal ? previousKeys : [img.objectKey, ...previousKeys]);
  }
  await invalidate(`catalog:product:${await productSlug(img.productId)}`);
}

export async function markImageFailed(imageId: string, error: string) {
  await prisma.productImage.updateMany({ where: { id: imageId, status: "PROCESSING" }, data: { status: "FAILED", error: error.slice(0, 500) } });
}

/** Removes abandoned uploads and re-queues stuck processing. */
export async function sweepImages() {
  const abandoned = await prisma.productImage.findMany({
    where: { status: "PENDING_UPLOAD", url: null, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
    take: 200,
  });
  if (abandoned.length) {
    await storage().delete(abandoned.map((a) => a.objectKey));
    await prisma.productImage.deleteMany({ where: { id: { in: abandoned.map((a) => a.id) } } });
  }
  const stuck = await prisma.productImage.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
    select: { id: true },
    take: 100,
  });
  for (const s of stuck) await enqueue(QUEUE_NAMES.media, "image.process", { imageId: s.id }, { jobId: `img-${s.id}-sweep-${Date.now()}` });
  if (abandoned.length || stuck.length) logger.info({ abandoned: abandoned.length, requeued: stuck.length }, "image sweep");
  return { abandoned: abandoned.length, requeued: stuck.length };
}
