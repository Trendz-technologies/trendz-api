import { Router } from "express";
import sharp from "sharp";
import { AppError, badRequest } from "../../common/errors/app-error";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { ok } from "../../common/utils/http";
import { env } from "../../config/env";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "../../integrations/object-storage";

export const aiProductDraftRouter = Router();
aiProductDraftRouter.use(authenticate, requireStaff, requirePermission("products.write"));

const rawImage = (["image/jpeg", "image/png", "image/webp", "image/avif"] as const);

type ProductCopy = {
  name: string;
  productType: string;
  shortDescription: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string;
  tags: string[];
};

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function parseProductCopy(value: unknown): ProductCopy {
  if (!value || typeof value !== "object") throw new Error("AI response did not contain product copy");
  const raw = value as Record<string, unknown>;
  const result: ProductCopy = {
    name: cleanText(raw.name, 200),
    productType: cleanText(raw.productType, 60),
    shortDescription: cleanText(raw.shortDescription, 500),
    description: cleanText(raw.description, 6000),
    seoTitle: cleanText(raw.seoTitle, 70),
    seoDescription: cleanText(raw.seoDescription, 170),
    seoKeywords: cleanText(raw.seoKeywords, 300),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => cleanText(t, 40).toLowerCase()).filter(Boolean).slice(0, 15) : [],
  };
  if (!result.name || !result.shortDescription || !result.description || !result.seoTitle || !result.seoDescription) {
    throw new Error("AI response was missing required product copy");
  }
  return result;
}

async function openAiJson(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    // Do not echo upstream response details or credentials into the API response.
    throw new AppError(502, "AI_PROVIDER_ERROR", "AI generation failed. Please try again.");
  }
  return body;
}

async function generateCopy(image: Buffer, mimeType: string): Promise<ProductCopy> {
  const response = await openAiJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_TEXT_MODEL,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Create ecommerce product copy for Trendz Women's Wear from this garment photo. Return JSON only with keys name, productType, shortDescription, description, seoTitle, seoDescription, seoKeywords, tags (array of strings). Describe only details clearly visible in the image. Do not guess fabric composition, exact materials, origin, brand, care instructions, price, sizes, stock, or occasion-specific claims not supported by the photo. Mention visible colours, silhouette, neckline, sleeve and embroidery/border details where clear. Keep the name natural, SEO title at most 70 characters, SEO description at most 170 characters, shortDescription at most 500 characters, tags lowercase." },
          { type: "input_image", image_url: `data:${mimeType};base64,${image.toString("base64")}`, detail: "high" },
        ],
      }],
      text: { format: { type: "json_object" } },
    }),
  });
  const outputText = typeof response?.output_text === "string" ? response.output_text : "";
  if (!outputText) throw new Error("AI did not return product copy");
  return parseProductCopy(JSON.parse(outputText));
}

async function generateModelImage(image: Buffer, mimeType: string): Promise<Buffer> {
  const form = new FormData();
  form.append("model", env.OPENAI_IMAGE_MODEL);
  form.append("prompt", "Create a premium photorealistic ecommerce fashion photograph of an adult Indian female model wearing the exact garment in the supplied reference photo. Preserve the garment's original colour palette, silhouette, neckline, sleeve shape, embroidery, motifs, trim, borders, fabric appearance, and dupatta exactly as visible. Do not redesign, simplify, recolour, add embellishments, or replace garment details. Show a graceful full-length standing pose with the complete outfit visible head to toe, neutral elegant studio background, natural proportions, professional soft studio lighting, subtle accessories that do not cover the garment. No text, watermark, logo, collage, or extra people. The garment is the priority; retain the reference garment design as faithfully as possible.");
  form.append("size", "1024x1536");
  form.append("input_fidelity", "high");
  form.append("output_format", "jpeg");
  form.append("image", new Blob([new Uint8Array(image)], { type: mimeType }), "garment-reference");

  const response = await openAiJson("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  const images = Array.isArray(response?.data) ? response.data as Array<Record<string, unknown>> : [];
  const base64 = images[0]?.b64_json;
  if (typeof base64 !== "string" || !base64) throw new Error("AI did not return a model image");
  return Buffer.from(base64, "base64");
}

async function compressForUpload(image: Buffer): Promise<Buffer> {
  for (const quality of [84, 78, 72, 66, 60, 54]) {
    const output = await sharp(image, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1200, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (output.byteLength <= MAX_IMAGE_BYTES) return output;
  }
  throw new AppError(422, "AI_IMAGE_TOO_LARGE", "The generated image could not be compressed below the 2 MB upload limit. Please try again.");
}

aiProductDraftRouter.post(
  "/product-draft",
  (req, _res, next) => {
    const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      return next(badRequest("Upload a JPEG, PNG, WebP or AVIF garment image.", "INVALID_IMAGE_TYPE"));
    }
    return next();
  },
  (awaitableRawBody()),
  async (req, res) => {
    if (!env.OPENAI_API_KEY) throw new AppError(503, "AI_NOT_CONFIGURED", "AI product generation is not configured on the server.");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest("Choose a garment image first.", "IMAGE_REQUIRED");
    if (req.body.length > MAX_IMAGE_BYTES) throw new AppError(413, "IMAGE_TOO_LARGE", "Images must be 2 MB or smaller.");

    const mimeType = req.headers["content-type"]!.split(";")[0]!.trim().toLowerCase();
    if (!(rawImage as readonly string[]).includes(mimeType)) throw badRequest("Unsupported image type.", "INVALID_IMAGE_TYPE");
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(req.body, { limitInputPixels: 40_000_000 }).metadata();
    } catch {
      throw badRequest("The uploaded file is not a valid image.", "INVALID_IMAGE");
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000 || (metadata.pages ?? 1) > 1) {
      throw badRequest("Use a single-frame image with dimensions up to 40 megapixels.", "INVALID_IMAGE_DIMENSIONS");
    }

    const [copy, rawGeneratedImage] = await Promise.all([
      generateCopy(req.body, mimeType),
      generateModelImage(req.body, mimeType),
    ]);
    const generatedImage = await compressForUpload(rawGeneratedImage);
    ok(res, {
      ...copy,
      generatedImageBase64: generatedImage.toString("base64"),
      generatedImageMimeType: "image/jpeg",
      generatedImageBytes: generatedImage.byteLength,
    });
  },
);

function awaitableRawBody() {
  // Route-local parser: the global JSON parser intentionally ignores image/* requests.
  const { raw } = require("express") as typeof import("express");
  return raw({ type: rawImage as unknown as string[], limit: MAX_IMAGE_BYTES });
}
