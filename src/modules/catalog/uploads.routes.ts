import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { forbidden } from "../../common/errors/app-error";
import { ok } from "../../common/utils/http";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, storage } from "../../integrations/object-storage";
import { IMAGE_TOO_LARGE } from "../media/upload-limit";

/**
 * Upload tickets for small, directly-served images (category images, brand
 * logos, pictures for the home page offers): the browser sends the file
 * straight to image storage. Product images use the processing pipeline in
 * /products/:id/images.
 */
export const uploadsRouter = Router();
uploadsRouter.use(authenticate, requireStaff);

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
const PURPOSE_PERMISSION = { category: "categories.write", brand: "brands.write", content: "settings.write" } as const;
const PURPOSE_FOLDER = { category: "categories", brand: "brands", content: "content" } as const;

const presignSchema = z.object({
  purpose: z.enum(["category", "brand", "content"]),
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
  size: z.number().int().positive().max(MAX_IMAGE_BYTES, IMAGE_TOO_LARGE),
});

uploadsRouter.post("/presign", async (req, res) => {
  const input = presignSchema.parse(req.body);
  if (!req.auth!.permissions.includes(PURPOSE_PERMISSION[input.purpose])) throw forbidden();
  const key = `public/${PURPOSE_FOLDER[input.purpose]}/${randomUUID()}.${EXT[input.contentType]}`;
  const ticket = await storage().uploadTicket(key, input.contentType, input.size);
  ok(res, { key, ...ticket, publicUrl: storage().publicUrl(key) });
});
