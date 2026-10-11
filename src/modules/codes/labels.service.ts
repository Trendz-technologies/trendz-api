import { z } from "zod";
import type { CodeType } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { badRequest } from "../../common/errors/app-error";
import { createPdf, MM, renderPdf, rupees } from "../../common/pdf/pdf";
import { renderCodePng } from "./codes.service";

/** Label stock presets. A4 sheets for laser printers, rolls for thermal printers. */
export const LABEL_LAYOUTS = {
  A4_3x8: { page: "A4", cols: 3, rows: 8, width: 70, height: 37.125, marginX: 0, marginY: 0 },
  A4_2x5: { page: "A4", cols: 2, rows: 5, width: 105, height: 59.4, marginX: 0, marginY: 0 },
  ROLL_50x25: { page: [50, 25], cols: 1, rows: 1, width: 50, height: 25, marginX: 0, marginY: 0 },
  ROLL_38x25: { page: [38, 25], cols: 1, rows: 1, width: 38, height: 25, marginX: 0, marginY: 0 },
} as const;

export const labelsSchema = z.object({
  items: z.array(z.object({ variantId: z.uuid(), copies: z.number().int().min(1).max(500).default(1) })).min(1).max(1000),
  layout: z.enum(Object.keys(LABEL_LAYOUTS) as [keyof typeof LABEL_LAYOUTS, ...(keyof typeof LABEL_LAYOUTS)[]]).default("A4_3x8"),
  show: z
    .object({
      name: z.boolean().default(true),
      variant: z.boolean().default(true),
      sku: z.boolean().default(true),
      price: z.enum(["mrp", "selling", "both", "none"]).default("mrp"),
      qr: z.boolean().default(true),
      barcode: z.boolean().default(true),
    })
    .prefault({}),
  barcodeType: z.enum(["EAN13", "UPC", "CODE128"]).default("CODE128"),
});

const MAX_LABELS = 5000;

/**
 * Builds a printable label sheet. Each label uses the variant's active codes;
 * when a code of the requested type does not exist yet, the SKU itself is
 * encoded (SKUs always resolve when scanned, so the label still works).
 */
export async function buildLabelsPdf(input: z.infer<typeof labelsSchema>): Promise<Buffer> {
  const total = input.items.reduce((s, i) => s + i.copies, 0);
  if (total > MAX_LABELS) throw badRequest(`At most ${MAX_LABELS} labels per sheet`);

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: input.items.map((i) => i.variantId) } },
    include: { product: { select: { name: true } }, codes: { where: { status: "ACTIVE" } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  if (byId.size !== new Set(input.items.map((i) => i.variantId)).size) throw badRequest("One or more variants were not found");

  // Render each variant's images once, then reuse them for every copy.
  const rendered = new Map<string, { qr: Buffer | null; barcode: Buffer | null }>();
  for (const v of variants) {
    const qrCode = v.codes.find((c) => c.codeType === "QR");
    const barcode = v.codes.find((c) => c.codeType === input.barcodeType) ?? null;
    const barcodeSource: { codeType: CodeType; codeValue: string; qrPayload: string | null } = barcode ?? { codeType: "CODE128", codeValue: v.sku, qrPayload: null };
    rendered.set(v.id, {
      qr: input.show.qr ? await renderCodePng(qrCode ?? { codeType: "QR", codeValue: v.sku, qrPayload: v.sku }, 4) : null,
      barcode: input.show.barcode ? await renderCodePng(barcodeSource, 2) : null,
    });
  }

  const layout = LABEL_LAYOUTS[input.layout];
  const size = typeof layout.page === "string" ? layout.page : [layout.page[0] * MM, layout.page[1] * MM];
  const doc = createPdf({ size, margin: 0, autoFirstPage: false });
  const w = layout.width * MM;
  const h = layout.height * MM;
  const perPage = layout.cols * layout.rows;
  const queue = input.items.flatMap((i) => Array.from({ length: i.copies }, () => i.variantId));

  return renderPdf(doc, (d) => {
    queue.forEach((variantId, n) => {
      if (n % perPage === 0) d.addPage();
      const slot = n % perPage;
      const x = layout.marginX * MM + (slot % layout.cols) * w;
      const y = layout.marginY * MM + Math.floor(slot / layout.cols) * h;
      drawLabel(d, x, y, w, h, byId.get(variantId)!, rendered.get(variantId)!, input.show);
    });
  });
}

function drawLabel(
  d: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  v: { sku: string; title: string; mrp: number; sellingPrice: number; product: { name: string } },
  img: { qr: Buffer | null; barcode: Buffer | null },
  show: z.infer<typeof labelsSchema>["show"],
) {
  const pad = Math.min(w, h) * 0.06;
  const small = h < 30 * MM;
  const qrSize = img.qr ? Math.min(h - 2 * pad, w * 0.34) : 0;
  const textX = x + pad + (qrSize ? qrSize + pad : 0);
  const textW = x + w - pad - textX;
  let cy = y + pad;

  if (img.qr) d.image(img.qr, x + pad, y + pad, { width: qrSize, height: qrSize });

  const line = (text: string, font: string, fontSize: number) => {
    d.font(font).fontSize(fontSize).text(text, textX, cy, { width: textW, height: fontSize * 1.3, ellipsis: true, lineBreak: false });
    cy += fontSize * 1.3;
  };
  if (show.name) line(v.product.name, "condensed-bold", small ? 6.5 : 8);
  if (show.variant && v.title !== "Default") line(v.title, "condensed", small ? 6 : 7);
  if (show.sku) line(`SKU: ${v.sku}`, "condensed", small ? 6 : 7);
  if (show.price !== "none") {
    const price =
      show.price === "mrp"
        ? `MRP ${rupees(v.mrp)}`
        : show.price === "selling"
          ? rupees(v.sellingPrice)
          : `${rupees(v.sellingPrice)}  MRP ${rupees(v.mrp)}`;
    line(price, "bold", small ? 7 : 9);
    if (show.price !== "selling") line("(incl. of all taxes)", "condensed", 5);
  }
  if (img.barcode) {
    const remaining = y + h - pad - cy;
    if (remaining > 8) d.image(img.barcode, textX, cy, { fit: [textW, remaining] });
  }
}
