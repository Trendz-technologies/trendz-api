import { badRequest } from "../../common/errors/app-error";
import { MAX_IMAGE_BYTES, storage } from "../../integrations/object-storage";

/*
 * The upload size limit, applied to pictures that are already in storage.
 *
 * Every upload first asks the API for a ticket and states the file's size; a
 * size over the limit gets no ticket. R2 then refuses a file that is not that
 * size. Cloudinary has no such check, so a picture's real size is looked at
 * here, at the point where it is put to use: when a product photo's upload is
 * completed, and when a category image, brand logo or content picture is saved
 * on its record.
 */

/** The sentence shown wherever a picture is refused for its size. */
export const IMAGE_TOO_LARGE = `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`;

/** Refuses a stored picture whose size is over the limit, and removes it from storage. */
export async function refuseIfOversized(key: string, size: number) {
  if (size <= MAX_IMAGE_BYTES) return;
  // Best effort: the picture is refused whether or not the clean-up works.
  await storage()
    .delete([key])
    .catch(() => undefined);
  throw badRequest(IMAGE_TOO_LARGE, "IMAGE_TOO_LARGE");
}

/**
 * Checks pictures that a save attaches to a record by their storage keys.
 * `previous` are the keys the record already had: those were checked when they
 * were attached, so only the new ones are looked up.
 */
export async function checkAttachedImages(keys: (string | null | undefined)[], previous: (string | null | undefined)[] = []) {
  const store = storage();
  // The ticket already held the upload to its declared size.
  if (store.enforcesUploadSize) return;
  for (const key of new Set(keys)) {
    if (!key || previous.includes(key)) continue;
    const stored = await store.head(key);
    if (stored) await refuseIfOversized(key, stored.size);
  }
}
