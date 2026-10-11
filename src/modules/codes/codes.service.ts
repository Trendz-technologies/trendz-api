import bwipjs from "bwip-js";
import QRCode from "qrcode";
import { z } from "zod";
import type { CodeType, ProductCode } from "@prisma/client";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { nextSequenceValue } from "../../database/sequences";
import { badRequest, conflict, notFound } from "../../common/errors/app-error";
import { randomCode } from "../../common/utils/crypto";
import { audit, type AuditContext } from "../audit/audit.service";
import { getSetting } from "../settings/settings.service";
import { buildEan13, buildQrPayload, buildUpcA, isValidCode128, isValidEan13, isValidUpcA } from "./barcode-utils";

export const CODE_TYPES = ["QR", "EAN13", "UPC", "CODE128"] as const;

export const createCodeSchema = z.object({
  type: z.enum(CODE_TYPES),
  // Omit to generate; provide to assign an existing barcode (e.g. the manufacturer's EAN).
  value: z.string().trim().min(1).max(48).optional(),
});

export const bulkGenerateSchema = z
  .object({
    variantIds: z.array(z.uuid()).max(2000).optional(),
    productIds: z.array(z.uuid()).max(500).optional(),
    types: z.array(z.enum(CODE_TYPES)).min(1).max(4),
  })
  .refine((v) => (v.variantIds?.length ?? 0) + (v.productIds?.length ?? 0) > 0, "Select at least one product or variant");

function validateValue(type: CodeType, value: string) {
  const ok =
    type === "EAN13" ? isValidEan13(value) : type === "UPC" ? isValidUpcA(value) : type === "CODE128" ? isValidCode128(value) : /^[A-Z0-9-]{4,48}$/.test(value);
  if (!ok) {
    const hint = { EAN13: "13 digits with a valid check digit", UPC: "12 digits with a valid check digit", CODE128: "1-48 printable ASCII characters", QR: "4-48 letters, digits or hyphens" }[type];
    throw badRequest(`Invalid ${type} value — expected ${hint}`, "INVALID_CODE");
  }
}

/** A code value must never be ambiguous with another variant's SKU. */
async function assertUnambiguous(tx: Tx, value: string, variantId: string) {
  const [code, skuOwner] = await Promise.all([
    tx.productCode.findUnique({ where: { codeValue: value }, select: { variantId: true, sku: true } }),
    tx.productVariant.findUnique({ where: { sku: value.toUpperCase() }, select: { id: true } }),
  ]);
  if (code) throw conflict(`Code ${value} is already assigned to ${code.sku}`, "DUPLICATE_CODE");
  if (skuOwner && skuOwner.id !== variantId) throw conflict(`Code ${value} equals the SKU of another product`, "DUPLICATE_CODE");
}

async function generateValue(tx: Tx, type: CodeType, sku: string): Promise<string> {
  switch (type) {
    case "QR": {
      for (let i = 0; i < 5; i++) {
        const candidate = `Q${randomCode(10)}`;
        if (!(await tx.productCode.findUnique({ where: { codeValue: candidate }, select: { id: true } }))) return candidate;
      }
      throw new Error("Could not generate a unique QR identifier");
    }
    case "EAN13": {
      const { ean13Prefix } = await getSetting("barcodes");
      return buildEan13(ean13Prefix, await nextSequenceValue(tx, `EAN13:${ean13Prefix}`));
    }
    case "UPC":
      return buildUpcA(await nextSequenceValue(tx, "UPC:2"));
    case "CODE128":
      return sku; // Code 128 encodes the SKU itself by default
  }
}

async function createCode(tx: Tx, variant: { id: string; productId: string; sku: string }, type: CodeType, value: string | undefined, ctx: AuditContext) {
  const codeValue = value ?? (await generateValue(tx, type, variant.sku));
  if (value) validateValue(type, value);
  await assertUnambiguous(tx, codeValue, variant.id);
  const code = await tx.productCode.create({
    data: {
      productId: variant.productId,
      variantId: variant.id,
      sku: variant.sku,
      codeType: type,
      codeValue,
      qrPayload: type === "QR" ? buildQrPayload(variant.sku, codeValue) : null,
      createdById: ctx.userId,
    },
  });
  await audit(tx, ctx, { action: value ? "code.assign" : "code.generate", entityType: "product_code", entityId: code.id, newValue: { sku: variant.sku, type, codeValue } });
  return code;
}

export async function addCode(variantId: string, input: z.infer<typeof createCodeSchema>, ctx: AuditContext) {
  const variant = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, productId: true, sku: true } });
  if (!variant) throw notFound("Variant");
  return withTransaction((tx) => createCode(tx, variant, input.type, input.value, ctx));
}

export async function setCodeStatus(id: string, status: "ACTIVE" | "INACTIVE", ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const before = await tx.productCode.findUnique({ where: { id } });
    if (!before) throw notFound("Code");
    const code = await tx.productCode.update({ where: { id }, data: { status } });
    await audit(tx, ctx, { action: status === "ACTIVE" ? "code.activate" : "code.deactivate", entityType: "product_code", entityId: id, oldValue: before.status, newValue: status });
    return code;
  });
}

/** Deactivates the code and issues a fresh one of the same type (history is kept). */
export async function regenerateCode(id: string, ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const old = await tx.productCode.findUnique({ where: { id }, include: { variant: { select: { id: true, productId: true, sku: true } } } });
    if (!old) throw notFound("Code");
    if (old.codeType === "CODE128" && old.codeValue === old.variant.sku) {
      throw badRequest("A Code 128 barcode of the SKU cannot be regenerated; change the SKU or assign a custom value instead");
    }
    await tx.productCode.update({ where: { id }, data: { status: "INACTIVE" } });
    await audit(tx, ctx, { action: "code.deactivate", entityType: "product_code", entityId: id, oldValue: "ACTIVE", newValue: "INACTIVE" });
    return createCode(tx, old.variant, old.codeType, undefined, ctx);
  });
}

export async function bulkGenerate(input: z.infer<typeof bulkGenerateSchema>, ctx: AuditContext) {
  const variants = await prisma.productVariant.findMany({
    where: {
      OR: [{ id: { in: input.variantIds ?? [] } }, { productId: { in: input.productIds ?? [] } }],
      status: { not: "DISCONTINUED" },
    },
    select: { id: true, productId: true, sku: true, codes: { where: { status: "ACTIVE" }, select: { codeType: true } } },
    take: 5000,
  });
  let created = 0;
  let skipped = 0;
  // Small transactions keep locks short; each code is independent.
  for (const v of variants) {
    for (const type of input.types) {
      if (v.codes.some((c) => c.codeType === type)) {
        skipped += 1;
        continue;
      }
      try {
        await withTransaction((tx) => createCode(tx, v, type, undefined, ctx));
        created += 1;
      } catch (err) {
        if ((err as { code?: string }).code === "DUPLICATE_CODE") skipped += 1;
        else throw err;
      }
    }
  }
  return { variants: variants.length, created, skipped };
}

export function listCodesForProduct(productId: string) {
  return prisma.productCode.findMany({
    where: { productId },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    include: { variant: { select: { title: true } } },
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BCID: Record<Exclude<CodeType, "QR">, string> = { EAN13: "ean13", UPC: "upca", CODE128: "code128" };

export async function renderCodePng(code: Pick<ProductCode, "codeType" | "codeValue" | "qrPayload">, scale = 3): Promise<Buffer> {
  if (code.codeType === "QR") {
    return QRCode.toBuffer(code.qrPayload ?? code.codeValue, { errorCorrectionLevel: "M", margin: 1, scale: Math.max(2, scale * 2) });
  }
  return bwipjs.toBuffer({ bcid: BCID[code.codeType], text: code.codeValue, scale, height: 12, includetext: true, textxalign: "center" });
}

export async function renderCodeSvg(code: Pick<ProductCode, "codeType" | "codeValue" | "qrPayload">): Promise<string> {
  if (code.codeType === "QR") return QRCode.toString(code.qrPayload ?? code.codeValue, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return bwipjs.toSVG({ bcid: BCID[code.codeType], text: code.codeValue, height: 12, includetext: true, textxalign: "center" });
}

export async function getCode(id: string) {
  const code = await prisma.productCode.findUnique({ where: { id } });
  if (!code) throw notFound("Code");
  return code;
}
