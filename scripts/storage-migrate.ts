/**
 * Moves the pictures that are still on R2 / MinIO to Cloudinary and points the
 * database at the new copies. For switching an environment that already has
 * images: set STORAGE_PROVIDER=cloudinary and the Cloudinary credentials, keep
 * the R2_* settings (the pictures are read from there), then:
 *
 *   npm run storage:migrate              lists what would be moved; nothing is changed
 *   npm run storage:migrate -- --apply   moves it
 *
 * Safe to run again: a picture that is already on Cloudinary is skipped. The
 * files on R2 / MinIO are left where they are.
 */
import { env } from "../src/config/env";
import { prisma } from "../src/database/prisma";
import { closeRedis, invalidatePattern } from "../src/database/redis";
import { cloudinaryStorage, r2Storage } from "../src/integrations/object-storage";
import { closeQueues } from "../src/jobs/queues";
import type { ImageSizes } from "../src/modules/media/image-view";
import { processImage } from "../src/modules/media/images.service";

const apply = process.argv.includes("--apply");
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };
const typeOf = (key: string) => TYPES[key.split(".").pop()!.toLowerCase()] ?? "image/jpeg";
const CONTENT_KEY = /^public\/content\/[\w.-]+$/;

async function main() {
  if (env.STORAGE_PROVIDER !== "cloudinary") {
    throw new Error("Set STORAGE_PROVIDER=cloudinary (and the Cloudinary credentials) first: this moves pictures to the storage the application has been switched to.");
  }
  const from = r2Storage();
  const to = cloudinaryStorage();
  const onCloudinary = (url: string | null) => Boolean(url?.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`));
  console.log(`${apply ? "Moving" : "Dry run: would move"} pictures from ${env.R2_ENDPOINT ?? "R2"} (bucket "${env.R2_BUCKET_NAME}") to Cloudinary (cloud "${env.CLOUDINARY_CLOUD_NAME}", folder "${env.CLOUDINARY_FOLDER}")\n`);

  const count = { moved: 0, alreadyThere: 0, failed: 0 };
  /** Runs one move (or, in a dry run, only names it) and keeps count. */
  const move = async (what: string, run: () => Promise<void>) => {
    if (!apply) {
      count.moved++;
      console.log(`  would move ${what}`);
      return;
    }
    try {
      await run();
      count.moved++;
      console.log(`✔ ${what}`);
    } catch (err) {
      count.failed++;
      console.error(`✘ ${what}: ${(err as Error).message}`);
    }
  };
  const copy = async (key: string) => to.put(key, await from.get(key), typeOf(key));

  // Product photos. The upload itself was never kept on R2, so the largest stored size becomes the photo on Cloudinary.
  for (const img of await prisma.productImage.findMany({ where: { status: "READY" }, orderBy: { createdAt: "asc" } })) {
    if (onCloudinary(img.url)) {
      count.alreadyThere++;
      continue;
    }
    const source = ((img.sizes ?? {}) as ImageSizes).large?.key;
    if (!source) {
      count.failed++;
      console.error(`✘ product photo ${img.id}: it has no stored file to copy`);
      continue;
    }
    await move(`product photo ${img.id} (${source})`, async () => {
      const objectKey = `uploads/products/${img.productId}/${img.id}/${Date.now().toString(36)}`;
      await to.put(objectKey, await from.get(source), typeOf(source));
      try {
        // From here it is an ordinary upload waiting for its sizes: the step the worker runs.
        await prisma.productImage.update({ where: { id: img.id }, data: { objectKey, status: "PROCESSING", error: null } });
        await processImage(img.id);
      } catch (err) {
        // Leave the photo as it was (still served from R2) so the next run tries again.
        await prisma.productImage.update({ where: { id: img.id }, data: { objectKey: img.objectKey, status: "READY" } });
        await to.delete([objectKey]).catch(() => undefined);
        throw err;
      }
    });
  }

  for (const category of await prisma.category.findMany({ where: { imageKey: { not: null } }, select: { id: true, name: true, imageKey: true, imageUrl: true } })) {
    const key = category.imageKey!;
    if (onCloudinary(category.imageUrl)) count.alreadyThere++;
    else
      await move(`picture of category "${category.name}" (${key})`, async () => {
        await copy(key);
        await prisma.category.update({ where: { id: category.id }, data: { imageUrl: to.publicUrl(key) } });
      });
  }

  for (const brand of await prisma.brand.findMany({ where: { logoKey: { not: null } }, select: { id: true, name: true, logoKey: true, logoUrl: true } })) {
    const key = brand.logoKey!;
    if (onCloudinary(brand.logoUrl)) count.alreadyThere++;
    else
      await move(`logo of brand "${brand.name}" (${key})`, async () => {
        await copy(key);
        await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl: to.publicUrl(key) } });
      });
  }

  // Pictures of the home page, the offers and the About page: the settings hold their keys, and their addresses are worked out when a page is read.
  const contentKeys = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      if (CONTENT_KEY.test(value)) contentKeys.add(value);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const setting of await prisma.setting.findMany({ select: { value: true } })) collect(setting.value);
  for (const key of contentKeys) {
    if (await to.head(key)) count.alreadyThere++;
    else await move(`content picture ${key}`, () => copy(key));
  }

  if (apply && count.moved) await invalidatePattern("catalog:*");
  console.log(`\n${apply ? "Moved" : "To move"}: ${count.moved}. Already on Cloudinary: ${count.alreadyThere}. Failed: ${count.failed}.`);
  if (!apply && count.moved) console.log('Run it again with "-- --apply" to move them.');
  if (count.failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  // Close every connection opened by app modules so the process can exit.
  .finally(() => Promise.allSettled([prisma.$disconnect(), closeRedis(), closeQueues()]));
