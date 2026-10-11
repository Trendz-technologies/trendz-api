import { Prisma, type CreditNote, type Invoice } from "@prisma/client";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { financialYear, nextFinancialYearNumber } from "../../database/sequences";
import { invalidState, notFound } from "../../common/errors/app-error";
import { allocate } from "../../common/utils/money";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { stateNameFor } from "../../common/utils/india";
import { createPdf, renderPdf, rupees } from "../../common/pdf/pdf";
import { env } from "../../config/env";
import { audit, systemContext, type AuditContext } from "../audit/audit.service";
import { createNotification, dispatchNotifications, registerAttachmentResolver } from "../notifications/notifications.service";
import { getSetting } from "../settings/settings.service";

export interface InvoiceLine {
  sku: string;
  description: string;
  hsnCode: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxable: number;
  taxRateBps: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

interface PartySnapshot {
  name: string;
  gstin?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: Record<string, unknown> | null;
}

const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

/**
 * Issues the invoice for a paid order (idempotent: one invoice per order).
 * The invoice is a frozen snapshot; the database refuses later edits.
 */
export async function issueInvoice(orderId: string, ctx: AuditContext = systemContext): Promise<Invoice> {
  const result = await withTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const existing = await tx.invoice.findUnique({ where: { orderId } });
    if (existing) return { invoice: existing, created: false };

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { createdAt: "asc" } }, payments: { where: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } } }, warehouse: true },
    });
    if (!order) throw notFound("Order");
    if (!PAID.has(order.paymentStatus)) throw invalidState("An invoice can only be issued for a paid order");

    const [store, invoiceSettings] = await Promise.all([getSetting("store"), getSetting("invoice")]);
    const invoiceNumber = await nextFinancialYearNumber(tx, invoiceSettings.prefix);
    const lines: InvoiceLine[] = order.items.map((i) => ({
      sku: i.sku,
      description: i.variantTitle === "Default" ? i.productName : `${i.productName} — ${i.variantTitle}`,
      hsnCode: i.hsnCode,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discountAmount,
      taxable: i.taxableAmount,
      taxRateBps: i.taxRateBps,
      cgst: i.cgstAmount,
      sgst: i.sgstAmount,
      igst: i.igstAmount,
      total: i.lineTotal,
    }));
    const sum = (f: (l: InvoiceLine) => number) => lines.reduce((s, l) => s + f(l), 0);
    // Shipping tax is part of order.taxTotal but not of any item line.
    const shippingTax = order.taxTotal - sum((l) => l.cgst + l.sgst + l.igst);
    const interState = order.placeOfSupply !== order.sellerStateCode;
    const shipCgst = interState ? 0 : Math.floor(shippingTax / 2);

    const seller: PartySnapshot = {
      name: store.legalName,
      gstin: order.warehouse?.gstin ?? store.gstin,
      email: store.email,
      phone: store.phone,
      address: { ...store.address, state: stateNameFor(store.address.stateCode) ?? store.address.state },
    };
    const buyer: PartySnapshot = { name: order.customerName ?? "Walk-in customer", email: order.customerEmail, phone: order.customerPhone };
    const paymentMethod = order.payments.map((p) => (p.method ? `${p.provider} (${p.method})` : p.provider)).join(", ") || "N/A";

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        orderId,
        financialYear: financialYear(),
        seller: seller as unknown as Prisma.InputJsonValue,
        buyer: buyer as unknown as Prisma.InputJsonValue,
        billingAddress: order.billingAddress ?? Prisma.JsonNull,
        shippingAddress: order.shippingAddress ?? Prisma.JsonNull,
        lines: lines as unknown as Prisma.InputJsonValue,
        placeOfSupply: order.placeOfSupply,
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        taxableTotal: sum((l) => l.taxable) + (order.shippingTotal - shippingTax),
        cgstTotal: sum((l) => l.cgst) + shipCgst,
        sgstTotal: sum((l) => l.sgst) + (interState ? 0 : shippingTax - shipCgst),
        igstTotal: sum((l) => l.igst) + (interState ? shippingTax : 0),
        shippingTotal: order.shippingTotal,
        roundOff: order.roundOff,
        grandTotal: order.grandTotal,
        paymentMethod,
        paymentStatus: order.paymentStatus,
      },
    });
    await audit(tx, ctx, { action: "invoice.issue", entityType: "invoice", entityId: invoice.id, newValue: { invoiceNumber, orderId } });

    const ids: (string | null)[] = [];
    if (order.customerEmail) {
      ids.push(
        await createNotification(tx, {
          channel: "EMAIL",
          template: "order.invoice",
          to: order.customerEmail,
          userId: order.userId,
          idempotencyKey: `invoice:${invoice.id}:email`,
          data: { orderNumber: order.orderNumber, invoiceNumber, url: `${env.WEB_URL}/account/orders/${order.orderNumber}` },
          attachments: [{ kind: "invoice", invoiceId: invoice.id }],
        }),
      );
    }
    return { invoice, created: true, ids };
  });
  if (result.created && "ids" in result) await dispatchNotifications(result.ids ?? []);
  return result.invoice;
}

/**
 * Credit note for a refund, against the original invoice. Lines are the
 * returned items when the refund comes from a return, the whole invoice for a
 * full refund, otherwise a proportional adjustment of every tax component.
 */
export async function issueCreditNoteForRefund(tx: Tx, refundId: string): Promise<CreditNote | null> {
  const existing = await tx.creditNote.findUnique({ where: { refundId } });
  if (existing) return existing;
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { returnRequest: { include: { items: { include: { orderItem: true } } } } } });
  const invoice = await tx.invoice.findUnique({ where: { orderId: refund.orderId } });
  if (!invoice) return null; // nothing invoiced yet → nothing to credit

  const invLines = invoice.lines as unknown as InvoiceLine[];
  let lines: InvoiceLine[];
  if (refund.returnRequest?.items.length) {
    lines = refund.returnRequest.items.map((ri) => {
      const oi = ri.orderItem;
      const share = (v: number) => Math.round((v * ri.quantity) / oi.quantity);
      return {
        sku: oi.sku,
        description: `Return: ${oi.productName} — ${oi.variantTitle}`,
        hsnCode: oi.hsnCode,
        quantity: ri.quantity,
        unitPrice: oi.unitPrice,
        discount: share(oi.discountAmount),
        taxable: share(oi.taxableAmount),
        taxRateBps: oi.taxRateBps,
        cgst: share(oi.cgstAmount),
        sgst: share(oi.sgstAmount),
        igst: share(oi.igstAmount),
        total: share(oi.lineTotal),
      };
    });
  } else if (refund.amount >= invoice.grandTotal) {
    lines = invLines.map((l) => ({ ...l, description: `Refund: ${l.description}` }));
  } else {
    const ratio = (v: number) => Math.round((v * refund.amount) / invoice.grandTotal);
    const [cgst, sgst, igst] = [ratio(invoice.cgstTotal), ratio(invoice.sgstTotal), ratio(invoice.igstTotal)];
    lines = [
      {
        sku: "-",
        description: refund.reason ? `Refund adjustment: ${refund.reason}` : "Refund adjustment",
        hsnCode: null,
        quantity: 1,
        unitPrice: refund.amount,
        discount: 0,
        taxable: refund.amount - cgst - sgst - igst,
        taxRateBps: 0,
        cgst,
        sgst,
        igst,
        total: refund.amount,
      },
    ];
  }

  // Make the credit note total equal the refunded amount exactly.
  const linesTotal = lines.reduce((s, l) => s + l.total, 0);
  if (linesTotal !== refund.amount && lines.length) {
    const scaled = allocate(refund.amount, lines.map((l) => l.total));
    lines = lines.map((l, i) => {
      const factor = l.total ? scaled[i]! / l.total : 0;
      const tax = Math.round((l.cgst + l.sgst + l.igst) * factor);
      const cgst = l.igst ? 0 : Math.floor(tax / 2);
      return { ...l, total: scaled[i]!, cgst, sgst: l.igst ? 0 : tax - cgst, igst: l.igst ? tax : 0, taxable: scaled[i]! - tax };
    });
  }
  const { creditNotePrefix } = await getSetting("invoice");
  return tx.creditNote.create({
    data: {
      creditNoteNumber: await nextFinancialYearNumber(tx, creditNotePrefix),
      invoiceId: invoice.id,
      orderId: refund.orderId,
      refundId,
      reason: refund.reason,
      lines: lines as unknown as Prisma.InputJsonValue,
      taxableTotal: lines.reduce((s, l) => s + l.taxable, 0),
      cgstTotal: lines.reduce((s, l) => s + l.cgst, 0),
      sgstTotal: lines.reduce((s, l) => s + l.sgst, 0),
      igstTotal: lines.reduce((s, l) => s + l.igst, 0),
      total: refund.amount,
    },
  });
}

// ---------------------------------------------------------------------------
// PDF rendering (from the frozen snapshot only)
// ---------------------------------------------------------------------------

function addressLines(a: Record<string, unknown> | null | undefined): string[] {
  if (!a) return [];
  const g = (k: string) => (a[k] ? String(a[k]) : "");
  return [g("fullName"), g("line1"), g("line2"), g("landmark"), [g("city"), g("state"), g("postalCode")].filter(Boolean).join(", "), g("phone") ? `Phone: ${g("phone")}` : ""].filter(Boolean);
}

function drawDocument(
  doc: PDFKit.PDFDocument,
  title: string,
  meta: [string, string][],
  seller: PartySnapshot,
  buyer: PartySnapshot,
  billing: Record<string, unknown> | null,
  shipping: Record<string, unknown> | null,
  lines: InvoiceLine[],
  totals: [string, number, boolean?][],
  footer: string[],
) {
  const left = 36;
  const width = doc.page.width - 72;
  doc.font("bold").fontSize(16).text(seller.name, left, 36, { width: width * 0.6 });
  doc.font("regular").fontSize(8).fillColor("#444");
  const sAddr = seller.address as Record<string, unknown> | undefined;
  doc.text([sAddr?.line1, sAddr?.line2, [sAddr?.city, sAddr?.state, sAddr?.postalCode].filter(Boolean).join(", ")].filter(Boolean).join("\n"), { width: width * 0.6 });
  if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`);
  if (seller.email || seller.phone) doc.text([seller.email, seller.phone].filter(Boolean).join(" · "));
  doc.fillColor("#111").font("bold").fontSize(14).text(title, left + width * 0.6, 36, { width: width * 0.4, align: "right" });
  doc.font("regular").fontSize(8);
  let my = 58;
  for (const [k, v] of meta) {
    doc.text(`${k}: ${v}`, left + width * 0.5, my, { width: width * 0.5, align: "right" });
    my += 11;
  }

  let y = Math.max(doc.y, my) + 14;
  const col = width / 3;
  const block = (label: string, rows: string[], x: number) => {
    doc.font("bold").fontSize(8).text(label, x, y, { width: col - 8 });
    doc.font("regular").fontSize(8).text(rows.join("\n") || "-", x, y + 11, { width: col - 8 });
  };
  block("Customer", [buyer.name, buyer.email ?? "", buyer.phone ?? ""].filter(Boolean), left);
  block("Billing address", addressLines(billing), left + col);
  block("Shipping address", addressLines(shipping), left + 2 * col);
  y += 80;

  // Table
  const cols = [
    { k: "#", w: 18 },
    { k: "Item", w: 150 },
    { k: "HSN", w: 38 },
    { k: "Qty", w: 26, right: true },
    { k: "Rate", w: 52, right: true },
    { k: "Disc.", w: 44, right: true },
    { k: "Taxable", w: 56, right: true },
    { k: "GST", w: 52, right: true },
    { k: "Total", w: 0, right: true },
  ];
  cols[cols.length - 1]!.w = width - cols.slice(0, -1).reduce((s, c) => s + c.w, 0);
  const row = (values: string[], bold = false) => {
    let x = left;
    const h = 22;
    if (y + h > doc.page.height - 120) {
      doc.addPage();
      y = 40;
    }
    doc.font(bold ? "bold" : "condensed").fontSize(7.5);
    values.forEach((v, i) => {
      doc.text(v, x + 2, y + 4, { width: cols[i]!.w - 4, align: cols[i]!.right ? "right" : "left", height: h - 4, ellipsis: true });
      x += cols[i]!.w;
    });
    y += h;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#e5e5e5").lineWidth(0.5).stroke();
  };
  doc.rect(left, y, width, 22).fill("#f3f3f1").fillColor("#111");
  row(cols.map((c) => c.k), true);
  lines.forEach((l, i) => {
    const gst = l.igst ? `IGST ${rupees(l.igst)}` : `${rupees(l.cgst + l.sgst)}`;
    row([String(i + 1), `${l.description}\nSKU ${l.sku}`, l.hsnCode ?? "-", String(l.quantity), rupees(l.unitPrice), rupees(l.discount), rupees(l.taxable), `${(l.taxRateBps / 100).toFixed(1)}% ${gst}`, rupees(l.total)]);
  });

  // Totals
  y += 10;
  for (const [label, amount, bold] of totals) {
    doc.font(bold ? "bold" : "regular").fontSize(bold ? 10 : 8.5);
    doc.text(label, left + width - 260, y, { width: 160, align: "right" });
    doc.text(rupees(amount), left + width - 100, y, { width: 100, align: "right" });
    y += bold ? 16 : 12;
  }
  y += 16;
  doc.font("regular").fontSize(7.5).fillColor("#555");
  for (const f of footer) {
    doc.text(f, left, y, { width });
    y = doc.y + 4;
  }
  doc.fillColor("#111");
}

export async function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  const settings = await getSetting("invoice");
  const order = await prisma.order.findUniqueOrThrow({ where: { id: invoice.orderId }, select: { orderNumber: true, placedAt: true, pricesIncludeTax: true } });
  const lines = invoice.lines as unknown as InvoiceLine[];
  const interState = invoice.igstTotal > 0;
  const totals: [string, number, boolean?][] = [
    ["Gross amount", invoice.subtotal],
    ["Discount", -invoice.discountTotal],
    ["Taxable value", invoice.taxableTotal],
    ...(interState ? ([["IGST", invoice.igstTotal]] as [string, number][]) : ([["CGST", invoice.cgstTotal], ["SGST", invoice.sgstTotal]] as [string, number][])),
    ["Shipping", invoice.shippingTotal],
    ...(invoice.roundOff ? ([["Round off", invoice.roundOff]] as [string, number][]) : []),
    ["Grand total", invoice.grandTotal, true],
  ];
  return renderPdf(createPdf({ margin: 36, info: { Title: `Invoice ${invoice.invoiceNumber}` } }), (doc) =>
    drawDocument(
      doc,
      "TAX INVOICE",
      [
        ["Invoice no.", invoice.invoiceNumber],
        ["Invoice date", invoice.issuedAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })],
        ["Order no.", order.orderNumber],
        ["Place of supply", `${stateNameFor(invoice.placeOfSupply) ?? ""} (${invoice.placeOfSupply})`],
        ["Payment", `${invoice.paymentMethod} · ${invoice.paymentStatus}`],
        ...(invoice.status === "CANCELLED" ? ([["Status", "CANCELLED"]] as [string, string][]) : []),
      ],
      invoice.seller as unknown as PartySnapshot,
      invoice.buyer as unknown as PartySnapshot,
      invoice.billingAddress as Record<string, unknown> | null,
      invoice.shippingAddress as Record<string, unknown> | null,
      lines,
      totals,
      [
        invoice.cgstTotal + invoice.sgstTotal + invoice.igstTotal > 0
          ? `Item prices are ${order.pricesIncludeTax ? "inclusive" : "exclusive"} of GST.`
          : "",
        settings.terms,
        settings.footerNote,
        "This is a computer-generated invoice and does not require a signature.",
      ].filter(Boolean),
    ),
  );
}

export async function renderCreditNotePdf(cn: CreditNote): Promise<Buffer> {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: cn.invoiceId } });
  const lines = cn.lines as unknown as InvoiceLine[];
  const totals: [string, number, boolean?][] = [
    ["Taxable value", cn.taxableTotal],
    ...(cn.igstTotal ? ([["IGST", cn.igstTotal]] as [string, number][]) : ([["CGST", cn.cgstTotal], ["SGST", cn.sgstTotal]] as [string, number][])),
    ["Total credited", cn.total, true],
  ];
  return renderPdf(createPdf({ margin: 36, info: { Title: `Credit note ${cn.creditNoteNumber}` } }), (doc) =>
    drawDocument(
      doc,
      "CREDIT NOTE",
      [
        ["Credit note no.", cn.creditNoteNumber],
        ["Date", cn.issuedAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })],
        ["Against invoice", invoice.invoiceNumber],
      ],
      invoice.seller as unknown as PartySnapshot,
      invoice.buyer as unknown as PartySnapshot,
      invoice.billingAddress as Record<string, unknown> | null,
      invoice.shippingAddress as Record<string, unknown> | null,
      lines,
      totals,
      [cn.reason ? `Reason: ${cn.reason}` : "", "This is a computer-generated document."].filter(Boolean),
    ),
  );
}

// Invoice PDFs are attached to emails at send time (never stored in the queue).
registerAttachmentResolver("invoice", async (ref) => {
  if (ref.kind !== "invoice") throw new Error("unexpected attachment kind");
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: ref.invoiceId } });
  return { filename: `${invoice.invoiceNumber.replace(/\//g, "-")}.pdf`, content: await renderInvoicePdf(invoice), contentType: "application/pdf" };
});
registerAttachmentResolver("credit_note", async (ref) => {
  if (ref.kind !== "credit_note") throw new Error("unexpected attachment kind");
  const cn = await prisma.creditNote.findUniqueOrThrow({ where: { id: ref.creditNoteId } });
  return { filename: `${cn.creditNoteNumber.replace(/\//g, "-")}.pdf`, content: await renderCreditNotePdf(cn), contentType: "application/pdf" };
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listInvoices(q: { q?: string; from?: Date; to?: Date }, page: Pagination) {
  const where: Prisma.InvoiceWhereInput = {
    issuedAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    OR: q.q ? [{ invoiceNumber: { contains: q.q.toUpperCase() } }, { order: { orderNumber: { contains: q.q.toUpperCase() } } }] : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { issuedAt: "desc" },
      ...pageArgs(page),
      select: { id: true, invoiceNumber: true, issuedAt: true, status: true, grandTotal: true, cgstTotal: true, sgstTotal: true, igstTotal: true, paymentStatus: true, buyer: true, order: { select: { id: true, orderNumber: true, channel: true } } },
    }),
    prisma.invoice.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export async function getInvoice(id: string) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { order: { select: { id: true, orderNumber: true } }, creditNotes: true } });
  if (!inv) throw notFound("Invoice");
  return inv;
}

export async function listCreditNotes(page: Pagination) {
  const [items, total] = await Promise.all([
    prisma.creditNote.findMany({ orderBy: { issuedAt: "desc" }, ...pageArgs(page), include: { invoice: { select: { invoiceNumber: true } }, order: { select: { orderNumber: true } } } }),
    prisma.creditNote.count(),
  ]);
  return { items, meta: pageMeta(page, total) };
}

