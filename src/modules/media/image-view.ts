import type { ProductImage } from "@prisma/client";

export interface SizeInfo {
  key: string;
  url: string;
  width: number;
  height: number;
}

/** Shape of product_images.sizes, written by the image processing job. */
export interface ImageSizes {
  thumb?: SizeInfo;
  medium?: SizeInfo;
  large?: SizeInfo;
  mediumAvif?: SizeInfo;
  largeAvif?: SizeInfo;
}

export const IMAGE_SIZES = {
  thumb: 320,
  medium: 800,
  large: 1600,
} as const;

export function imageView(img: Pick<ProductImage, "id" | "altText" | "variantId" | "sortOrder" | "status" | "url" | "width" | "height" | "sizes"> & { error?: string | null }) {
  const sizes = (img.sizes ?? {}) as ImageSizes;
  return {
    id: img.id,
    altText: img.altText,
    variantId: img.variantId,
    sortOrder: img.sortOrder,
    status: img.status,
    width: img.width,
    height: img.height,
    url: img.url ?? sizes.large?.url ?? null,
    thumb: sizes.thumb?.url ?? null,
    medium: sizes.medium?.url ?? null,
    large: sizes.large?.url ?? null,
    avif: { medium: sizes.mediumAvif?.url ?? null, large: sizes.largeAvif?.url ?? null },
    // Only failed images carry a reason (shown to staff so they know what to replace).
    error: img.status === "FAILED" ? (img.error ?? "Processing failed") : null,
  };
}

export type ImageView = ReturnType<typeof imageView>;

/** Every storage key belonging to an image (for deletion). */
export function imageKeys(img: Pick<ProductImage, "objectKey" | "sizes">): string[] {
  const sizes = (img.sizes ?? {}) as ImageSizes;
  return [img.objectKey, ...Object.values(sizes).map((s) => s.key)].filter(Boolean);
}
