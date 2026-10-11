import { prisma } from "../../database/prisma";
import { notFound } from "../../common/errors/app-error";
import { createPdf, MM, renderPdf, rupees } from "../../common/pdf/pdf";
import { getSettings } from "../settings/settings.service";

/** 80 mm thermal-printer receipt for an in-store sale. */
export async function renderReceipt(orderId: string): Promise<Buffer> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: { where: { status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } } }, invoice: { select: { invoiceNumber: true } }, warehouse: true, createdBy: { select: { email: true, profile: { select: { firstName: true } } } } },
  });
  if (!order) throw notFound("Order");
  const s = await getSettings();
  const width = 80 * MM;
  const height = (120 + order.items.length * 9) * MM;
  const doc = createPdf({ size: [width, height], margin: 8 });
  return renderPdf(doc, (d) => {
    const w = width - 16;
    const center = (text: string, size = 8, font = "condensed") => d.font(font).fontSize(size).text(text, 8, d.y, { width: w, align: "center" });
    const row = (left: string, right: string, bold = false) => {
      const y = d.y;
      d.font(bold ? "condensed-bold" : "condensed").fontSize(bold ? 9 : 8);
      d.text(left, 8, y, { width: w * 0.65 });
      const after = d.y;
      d.text(right, 8 + w * 0.6, y, { width: w * 0.4, align: "right" });
      d.y = Math.max(after, d.y);
    };
    const rule = () => {
      d.moveTo(8, d.y + 2).lineTo(width - 8, d.y + 2).dash(2, { space: 2 }).strokeColor("#000").stroke().undash();
      d.y += 6;
    };

    center(s.store.displayName.toUpperCase(), 12, "bold");
    center(s.store.legalName, 7);
    if (order.warehouse) center(`${order.warehouse.addressLine1}, ${order.warehouse.city}`, 7);
    if (order.warehouse?.gstin ?? s.store.gstin) center(`GSTIN ${order.warehouse?.gstin ?? s.store.gstin}`, 7);
    d.moveDown(0.5);
    rule();
    row(`Bill ${order.orderNumber}`, order.placedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }));
    if (order.invoice) row("Invoice", order.invoice.invoiceNumber);
    if (order.customerName) row("Customer", order.customerName);
    rule();
    for (const it of order.items) {
      row(`${it.productName}${it.variantTitle !== "Default" ? ` (${it.variantTitle})` : ""}`, rupees(it.lineTotal));
      d.font("condensed").fontSize(7).fillColor("#333").text(`  ${it.quantity} × ${rupees(it.unitPrice)}${it.discountAmount ? `  − ${rupees(it.discountAmount)}` : ""}  ·  ${it.sku}`, 8, d.y, { width: w });
      d.fillColor("#000");
    }
    rule();
    row("Subtotal", rupees(order.subtotal));
    if (order.discountTotal) row("Discount", `− ${rupees(order.discountTotal)}`);
    row(order.pricesIncludeTax ? "GST (included)" : "GST", rupees(order.taxTotal));
    if (order.roundOff) row("Round off", rupees(order.roundOff));
    row("TOTAL", rupees(order.grandTotal), true);
    rule();
    for (const p of order.payments) row(`Paid · ${p.provider}${p.referenceNumber ? ` (${p.referenceNumber})` : ""}`, rupees(p.amount));
    d.moveDown();
    center(s.invoice.footerNote, 8);
    center(`Returns within ${s.returns.windowDays} days with this receipt.`, 7);
  });
}
