import { z } from "zod";
import { prisma } from "../../database/prisma";
import { AppError, badRequest } from "../../common/errors/app-error";
import { imageView } from "../media/image-view";
import { getSetting } from "../settings/settings.service";
import { resolveRateBps, taxClassFor } from "../tax/tax.service";
import { parseScannedInput } from "./barcode-utils";

export const scanSchema = z.object({
  code: z.string().min(1).max(500),
  warehouseId: z.uuid(),
});

export type StockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "OTHER_WAREHOUSE";

/**
 * Resolves scanner input (QR payload, barcode value or SKU) to exactly one
 * variant. Never guesses: inactive or ambiguous codes are rejected.
 */
export async function resolveCode(raw: string): Promise<{ variantId: string; matchedBy: "CODE" | "SKU" }> {
  const { codeValue, sku } = parseScannedInput(raw);
  if (!codeValue && !sku) throw badRequest("Empty scan");

  if (codeValue) {
    const code = await prisma.productCode.findUnique({ where: { codeValue }, select: { variantId: true, status: true } });
    if (code) {
      if (code.status !== "ACTIVE") throw new AppError(409, "CODE_INACTIVE", "This product code is inactive.");
      const skuOwner = await prisma.productVariant.findUnique({ where: { sku: codeValue.toUpperCase() }, select: { id: true } });
      if (skuOwner && skuOwner.id !== code.variantId) {
        throw new AppError(409, "DUPLICATE_CODE", "Duplicate product code detected. Contact administrator.");
      }
      return { variantId: code.variantId, matchedBy: "CODE" };
    }
  }
  if (sku) {
    const variant = await prisma.productVariant.findUnique({ where: { sku }, select: { id: true } });
    if (variant) return { variantId: variant.id, matchedBy: "SKU" };
  }
  throw new AppError(404, "CODE_NOT_FOUND", "Product code not found.");
}

/** What a cashier sees after a scan. Contains no cost prices or internal data. */
export async function scanLookup(raw: string, warehouseId: string) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId }, select: { id: true, status: true } });
  if (!warehouse || warehouse.status !== "ACTIVE") throw badRequest("Select an active billing warehouse");

  const { variantId, matchedBy } = await resolveCode(raw);
  const v = await prisma.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: {
      product: { select: { id: true, name: true, status: true, taxClassId: true, hsnCode: true, images: { orderBy: { sortOrder: "asc" }, take: 1 } } },
      codes: { where: { status: "ACTIVE", codeType: { in: ["EAN13", "UPC", "CODE128"] } }, select: { codeType: true, codeValue: true } },
      inventoryLevels: { select: { warehouseId: true, onHand: true, reserved: true, warehouse: { select: { code: true, name: true, status: true } } } },
    },
  });

  if (v.status === "DISCONTINUED" || v.product.status === "DISCONTINUED" || v.product.status === "ARCHIVED") {
    throw new AppError(409, "PRODUCT_DISCONTINUED", "This product is discontinued.");
  }
  if (v.status !== "ACTIVE") throw new AppError(409, "PRODUCT_INACTIVE", "This product is not available for sale.");

  const here = v.inventoryLevels.find((l) => l.warehouseId === warehouseId);
  const availableStock = here ? here.onHand - here.reserved : 0;
  const elsewhere = v.inventoryLevels
    .filter((l) => l.warehouseId !== warehouseId && l.warehouse.status === "ACTIVE" && l.onHand - l.reserved > 0)
    .map((l) => ({ code: l.warehouse.code, name: l.warehouse.name, available: l.onHand - l.reserved }));

  const stockStatus: StockStatus = availableStock > 0 ? "IN_STOCK" : elsewhere.length ? "OTHER_WAREHOUSE" : "OUT_OF_STOCK";
  const message = { IN_STOCK: null, OUT_OF_STOCK: "Out of stock.", OTHER_WAREHOUSE: "Product available in another warehouse." }[stockStatus];

  const pricing = await getSetting("pricing");
  const taxRateBps = resolveRateBps(await taxClassFor(v.product.taxClassId), v.sellingPrice, pricing.pricesIncludeTax);
  const barcode = v.codes.find((c) => c.codeType === "EAN13") ?? v.codes.find((c) => c.codeType === "UPC") ?? v.codes[0] ?? null;

  return {
    product: {
      id: v.product.id,
      variantId: v.id,
      name: v.product.name,
      variant: v.title,
      sku: v.sku,
      barcode: barcode?.codeValue ?? null,
      hsnCode: v.product.hsnCode,
      mrp: v.mrp,
      price: v.sellingPrice,
      pricesIncludeTax: pricing.pricesIncludeTax,
      taxRateBps,
      tax: taxRateBps / 100,
      availableStock: Math.max(0, availableStock),
      stockStatus,
      message,
      otherWarehouses: stockStatus === "IN_STOCK" ? [] : elsewhere,
      image: v.product.images[0] ? imageView(v.product.images[0]).thumb : null,
      matchedBy,
    },
  };
}
