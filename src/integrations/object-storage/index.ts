import { env } from "../../config/env";
import { CloudinaryStorage } from "./cloudinary.storage";
import { R2Storage } from "./r2.storage";
import type { ObjectStorage } from "./storage.types";

export * from "./storage.types";

let r2: R2Storage | null = null;
let cloudinary: CloudinaryStorage | null = null;

/** Cloudflare R2 (locally MinIO), whatever STORAGE_PROVIDER says. For the scripts that set up the bucket or move images away from it. */
export function r2Storage(): R2Storage {
  r2 ??= new R2Storage();
  return r2;
}

/** Cloudinary, whatever STORAGE_PROVIDER says. Throws when its credentials are not set. */
export function cloudinaryStorage(): CloudinaryStorage {
  if (!cloudinary) {
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } = env;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Cloudinary is not configured (CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET)");
    }
    cloudinary = new CloudinaryStorage({ cloudName, apiKey, apiSecret, folder: env.CLOUDINARY_FOLDER, signatureAlgorithm: env.CLOUDINARY_SIGNATURE_ALGORITHM });
  }
  return cloudinary;
}

/** The image storage this environment uses (STORAGE_PROVIDER). */
export function storage(): ObjectStorage {
  return env.STORAGE_PROVIDER === "cloudinary" ? cloudinaryStorage() : r2Storage();
}
