import { raw, Router } from "express";
import sharp from "sharp";
import { AppError, badRequest } from "../../common/errors/app-error";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { ok } from "../../common/utils/http";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { ALLOWED_IMAGE_TYPES } from "../../integrations/object-storage";

export const aiProductDraftRouter = Router();
aiProductDraftRouter.use(authenticate, requireStaff, requirePermission("products.write"));

const rawImage = (["image/jpeg", "image/png", "image/webp", "image/avif"] as const);
const MAX_AI_INPUT_BYTES = 10 * 1024 * 1024;

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

async function geminiJson(init: RequestInit) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TEXT_MODEL}:generateContent`,
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY!,
        ...init.headers,
      },
      signal: AbortSignal.timeout(90_000),
    },
  );
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const rawError = body && typeof body.error === "object" && body.error !== null
      ? body.error as Record<string, unknown>
      : {};
    const safeText = (value: unknown) => typeof value === "string"
      ? value.replace(/[\\r\\n]+/g, " ").slice(0, 200)
      : undefined;
    logger.warn({
      provider: "gemini",
      status: response.status,
      errorStatus: safeText(rawError.status),
      errorMessage: safeText(rawError.message),
    }, "SEO AI provider request failed");
    throw new AppError(502, "AI_PROVIDER_ERROR", "SEO generation failed. Please try again.");
  }
  return body;
}

async function generateCopy(image: Buffer, mimeType: string): Promise<ProductCopy> {
  const response = await geminiJson({
    method: "POST",
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: "Create ecommerce product copy for Trendz Women's Wear from this garment photo. Return JSON only with keys name, productType, shortDescription, description, seoTitle, seoDescription, seoKeywords, tags (array of strings). Describe only details clearly visible in the image. Do not guess fabric composition, exact materials, origin, care instructions, price, sizes, stock, or occasion-specific claims not supported by the photo. Include \\"Trendz Women’s Wear\\" in the SEO title if it fits the 70-character limit. Mention visible colours, silhouette, neckline, sleeve and embroidery/border details where clear. Keep the name natural, SEO title at most 70 characters, SEO description at most 170 characters, shortDescription at most 500 characters, tags lowercase." },
          { inlineData: { mimeType, data: image.toString("base64") } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 1400,
      },
    }),
  });
  const candidates = Array.isArray(response?.candidates) ? response.candidates as Array<Record<string, unknown>> : [];
  const content = candidates[0]?.content && typeof candidates[0].content === "object"
    ? candidates[0].content as Record<string, unknown>
    : {};
  const parts = Array.isArray(content.parts) ? content.parts as Array<Record<string, unknown>> : [];
  const outputText = parts.filter((part) => typeof part.text === "string").map((part) => part.text as string).join("\\n");
  if (!outputText) throw new AppError(502, "AI_EMPTY_RESPONSE", "SEO AI did not return product details. Please try again.");
  try {
    return parseProductCopy(JSON.parse(outputText));
  } catch {
    throw new AppError(502, "AI_INVALID_RESPONSE", "SEO AI returned incomplete product details. Please try again.");
  }
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
    if (!env.GEMINI_API_KEY) throw new AppError(503, "AI_NOT_CONFIGURED", "SEO generation is not configured. Add GEMINI_API_KEY to the backend environment.");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest("Choose a garment image first.", "IMAGE_REQUIRED");
    if (req.body.length > MAX_AI_INPUT_BYTES) throw new AppError(413, "IMAGE_TOO_LARGE", "Garment photos must be 10 MB or smaller.");

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

    const normalizedImage = await sharp(req.body).rotate().jpeg({ quality: 88 }).toBuffer();
    const copy = await generateCopy(normalizedImage, "image/jpeg");
    ok(res, copy);
  },
);

function awaitableRawBody() {
  // Route-local parser: the global JSON parser intentionally ignores image/* requests.
  return raw({ type: rawImage as unknown as string[], limit: MAX_AI_INPUT_BYTES });
}
