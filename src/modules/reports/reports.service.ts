import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../database/prisma";
import { createPdf, renderPdf, rupees } from "../../common/pdf/pdf";
import { listLevels } from "../inventory/inventory.service";

export const REPORT_TYPES = ["sales", "orders", "products", "inventory", "low-stock", "customers", "refunds", "payments", "taxes", "suppliers", "purchases"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const reportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  channel: z.enum(["ONLINE", "POS"]).optional(),
  warehouseId: z.uuid().optional(),
  format: z.enum(["json", "csv", "xlsx", "pdf"]).default("json"),
});
export type ReportFilter = z.infer<typeof reportQuery>;

type ColumnType = "text" | "money" | "number" | "date" | "percent";
export interface Report {
  type: ReportType;
  title: string;
  period: { from: string; to: string };
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
}

const PAID = Prisma.sql`o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`;
const IST_DAY = (col: Prisma.Sql) => Prisma.sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`;
const n = (v: unknown) => Number(v ?? 0);

function period(f: ReportFilter) {
  const to = f.to ?? new Date();
  const from = f.from ?? new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

function sumColumns(rows: Record<string, unknown>[], keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + n(r[k]), 0)]));
}

export async function runReport(type: ReportType, f: ReportFilter): Promise<Report> {
  const { from, to } = period(f);
  const channel = f.channel ? Prisma.sql`AND o.channel = ${f.channel}::"SalesChannel"` : Prisma.empty;
  const range = Prisma.sql`o.placed_at >= ${from} AND o.placed_at <= ${to}`;
  const base = { type, period: { from: from.toISOString(), to: to.toISOString() } };

  switch (type) {
    case "sales": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        WITH days AS (
          SELECT ${IST_DAY(Prisma.sql`o.placed_at`)} AS day, COUNT(*) AS orders, SUM(o.subtotal) AS gross, SUM(o.discount_total) AS discounts,
                 SUM(o.tax_total) AS tax, SUM(o.shipping_total) AS shipping, SUM(o.grand_total) AS revenue
          FROM orders o WHERE ${PAID} AND ${range} ${channel} GROUP BY 1
        ), refunds AS (
          SELECT ${IST_DAY(Prisma.sql`r.created_at`)} AS day, SUM(r.amount) AS refunds
          FROM refunds r JOIN orders o ON o.id = r.order_id
          WHERE r.status IN ('PROCESSED', 'PROCESSING') AND r.created_at >= ${from} AND r.created_at <= ${to} ${channel} GROUP BY 1
        )
        SELECT COALESCE(d.day, r.day) AS day, COALESCE(d.orders, 0) AS orders, COALESCE(d.gross, 0) AS gross, COALESCE(d.discounts, 0) AS discounts,
               COALESCE(d.tax, 0) AS tax, COALESCE(d.shipping, 0) AS shipping, COALESCE(d.revenue, 0) AS revenue, COALESCE(r.refunds, 0) AS refunds,
               COALESCE(d.revenue, 0) - COALESCE(r.refunds, 0) AS net
        FROM days d FULL OUTER JOIN refunds r ON r.day = d.day ORDER BY 1`;
      const mapped = rows.map((r) => ({ ...r, day: String(r.day).slice(0, 10), orders: n(r.orders), gross: n(r.gross), discounts: n(r.discounts), tax: n(r.tax), shipping: n(r.shipping), revenue: n(r.revenue), refunds: n(r.refunds), net: n(r.net) }));
      return {
        ...base,
        title: "Sales by day",
        columns: [
          { key: "day", label: "Date", type: "date" },
          { key: "orders", label: "Orders", type: "number" },
          { key: "gross", label: "Gross", type: "money" },
          { key: "discounts", label: "Discounts", type: "money" },
          { key: "tax", label: "GST", type: "money" },
          { key: "shipping", label: "Shipping", type: "money" },
          { key: "revenue", label: "Revenue", type: "money" },
          { key: "refunds", label: "Refunds", type: "money" },
          { key: "net", label: "Net", type: "money" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["orders", "gross", "discounts", "tax", "shipping", "revenue", "refunds", "net"]),
      };
    }
    case "orders": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT o.order_number, o.placed_at, o.channel, o.customer_name, o.customer_phone, o.status, o.payment_status,
               (SELECT SUM(quantity) FROM order_items i WHERE i.order_id = o.id) AS items, o.discount_total, o.tax_total, o.grand_total, o.amount_refunded
        FROM orders o WHERE ${range} ${channel} ORDER BY o.placed_at DESC LIMIT 20000`;
      const mapped = rows.map((r) => ({ ...r, items: n(r.items), discount_total: n(r.discount_total), tax_total: n(r.tax_total), grand_total: n(r.grand_total), amount_refunded: n(r.amount_refunded) }));
      return {
        ...base,
        title: "Orders",
        columns: [
          { key: "order_number", label: "Order", type: "text" },
          { key: "placed_at", label: "Placed", type: "date" },
          { key: "channel", label: "Channel", type: "text" },
          { key: "customer_name", label: "Customer", type: "text" },
          { key: "customer_phone", label: "Phone", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "payment_status", label: "Payment", type: "text" },
          { key: "items", label: "Items", type: "number" },
          { key: "discount_total", label: "Discount", type: "money" },
          { key: "tax_total", label: "GST", type: "money" },
          { key: "grand_total", label: "Total", type: "money" },
          { key: "amount_refunded", label: "Refunded", type: "money" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["items", "discount_total", "tax_total", "grand_total", "amount_refunded"]),
      };
    }
    case "products": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT i.sku, i.product_name, i.variant_title, SUM(i.quantity) AS quantity, SUM(i.returned_quantity) AS returned,
               SUM(i.discount_amount) AS discount, SUM(i.tax_amount) AS tax, SUM(i.line_total) AS revenue,
               SUM(i.quantity * COALESCE(v.cost_price, 0)) AS cost
        FROM order_items i JOIN orders o ON o.id = i.order_id JOIN product_variants v ON v.id = i.variant_id
        WHERE ${PAID} AND ${range} ${channel}
        GROUP BY i.sku, i.product_name, i.variant_title ORDER BY revenue DESC LIMIT 5000`;
      const mapped = rows.map((r) => ({ ...r, quantity: n(r.quantity), returned: n(r.returned), discount: n(r.discount), tax: n(r.tax), revenue: n(r.revenue), cost: n(r.cost), margin: n(r.revenue) - n(r.tax) - n(r.cost) }));
      return {
        ...base,
        title: "Product sales",
        columns: [
          { key: "sku", label: "SKU", type: "text" },
          { key: "product_name", label: "Product", type: "text" },
          { key: "variant_title", label: "Variant", type: "text" },
          { key: "quantity", label: "Qty sold", type: "number" },
          { key: "returned", label: "Returned", type: "number" },
          { key: "discount", label: "Discount", type: "money" },
          { key: "tax", label: "GST", type: "money" },
          { key: "revenue", label: "Revenue", type: "money" },
          { key: "cost", label: "Cost", type: "money" },
          { key: "margin", label: "Margin (ex-GST)", type: "money" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["quantity", "returned", "discount", "tax", "revenue", "cost", "margin"]),
      };
    }
    case "inventory":
    case "low-stock": {
      const all: Record<string, unknown>[] = [];
      for (let page = 1; page <= 50; page++) {
        const { items, meta } = await listLevels({ warehouseId: f.warehouseId, status: type === "low-stock" ? "low" : "all" }, { page, limit: 100 });
        all.push(...items);
        if (page >= meta.totalPages) break;
      }
      if (type === "low-stock") {
        const { items } = await listLevels({ warehouseId: f.warehouseId, status: "out" }, { page: 1, limit: 100 });
        all.push(...items);
      }
      return {
        ...base,
        title: type === "inventory" ? "Inventory valuation" : "Low and out of stock",
        columns: [
          { key: "sku", label: "SKU", type: "text" },
          { key: "productName", label: "Product", type: "text" },
          { key: "title", label: "Variant", type: "text" },
          { key: "onHand", label: "On hand", type: "number" },
          { key: "reserved", label: "Reserved", type: "number" },
          { key: "available", label: "Available", type: "number" },
          { key: "damaged", label: "Damaged", type: "number" },
          { key: "lowStockThreshold", label: "Threshold", type: "number" },
          { key: "status", label: "Status", type: "text" },
          { key: "stockValue", label: "Value (cost)", type: "money" },
        ],
        rows: all,
        totals: sumColumns(all, ["onHand", "reserved", "available", "damaged", "stockValue"]),
      };
    }
    case "customers": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT u.email, u.phone, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS name, u.created_at,
               COUNT(o.id) FILTER (WHERE ${PAID}) AS orders, COALESCE(SUM(o.grand_total - o.amount_refunded) FILTER (WHERE ${PAID}), 0) AS spent,
               MAX(o.placed_at) AS last_order
        FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id LEFT JOIN orders o ON o.user_id = u.id AND ${range}
        WHERE u.is_staff = false
        GROUP BY u.id, p.first_name, p.last_name ORDER BY spent DESC LIMIT 20000`;
      const mapped = rows.map((r) => ({ ...r, orders: n(r.orders), spent: n(r.spent) }));
      return {
        ...base,
        title: "Customers",
        columns: [
          { key: "name", label: "Name", type: "text" },
          { key: "email", label: "Email", type: "text" },
          { key: "phone", label: "Phone", type: "text" },
          { key: "created_at", label: "Registered", type: "date" },
          { key: "orders", label: "Orders", type: "number" },
          { key: "spent", label: "Net spent", type: "money" },
          { key: "last_order", label: "Last order", type: "date" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["orders", "spent"]),
      };
    }
    case "refunds": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT r.refund_number, r.created_at, o.order_number, r.amount, r.status, pm.provider, r.reason, r.razorpay_refund_id
        FROM refunds r JOIN orders o ON o.id = r.order_id JOIN payments pm ON pm.id = r.payment_id
        WHERE r.created_at >= ${from} AND r.created_at <= ${to} ${channel} ORDER BY r.created_at DESC`;
      const mapped = rows.map((r) => ({ ...r, amount: n(r.amount) }));
      return {
        ...base,
        title: "Refunds",
        columns: [
          { key: "refund_number", label: "Refund", type: "text" },
          { key: "created_at", label: "Date", type: "date" },
          { key: "order_number", label: "Order", type: "text" },
          { key: "provider", label: "Method", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
          { key: "reason", label: "Reason", type: "text" },
          { key: "razorpay_refund_id", label: "Gateway ref", type: "text" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["amount"]),
      };
    }
    case "payments": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT pm.created_at, o.order_number, pm.provider, pm.method, pm.status, pm.amount, pm.amount_refunded,
               COALESCE(pm.razorpay_payment_id, pm.reference_number) AS reference
        FROM payments pm JOIN orders o ON o.id = pm.order_id
        WHERE pm.created_at >= ${from} AND pm.created_at <= ${to} ${channel} ORDER BY pm.created_at DESC LIMIT 20000`;
      const mapped = rows.map((r) => ({ ...r, amount: n(r.amount), amount_refunded: n(r.amount_refunded) }));
      return {
        ...base,
        title: "Payments",
        columns: [
          { key: "created_at", label: "Date", type: "date" },
          { key: "order_number", label: "Order", type: "text" },
          { key: "provider", label: "Provider", type: "text" },
          { key: "method", label: "Method", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
          { key: "amount_refunded", label: "Refunded", type: "money" },
          { key: "reference", label: "Reference", type: "text" },
        ],
        rows: mapped,
        totals: sumColumns(mapped.filter((r) => ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(String((r as Record<string, unknown>).status))), ["amount", "amount_refunded"]),
      };
    }
    case "taxes": {
      // GSTR-1 style summary by HSN and rate, split by supply type.
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(i.hsn_code, '-') AS hsn, i.tax_rate_bps,
               CASE WHEN o.place_of_supply = o.seller_state_code THEN 'Intra-state' ELSE 'Inter-state' END AS supply,
               SUM(i.quantity) AS quantity, SUM(i.taxable_amount) AS taxable, SUM(i.cgst_amount) AS cgst,
               SUM(i.sgst_amount) AS sgst, SUM(i.igst_amount) AS igst, SUM(i.tax_amount) AS tax, SUM(i.line_total) AS total
        FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE ${PAID} AND ${range} ${channel}
        GROUP BY 1, 2, 3 ORDER BY 1, 2`;
      const mapped = rows.map((r) => ({ ...r, rate: n(r.tax_rate_bps) / 100, quantity: n(r.quantity), taxable: n(r.taxable), cgst: n(r.cgst), sgst: n(r.sgst), igst: n(r.igst), tax: n(r.tax), total: n(r.total) }));
      return {
        ...base,
        title: "GST summary (HSN-wise)",
        columns: [
          { key: "hsn", label: "HSN", type: "text" },
          { key: "rate", label: "Rate %", type: "percent" },
          { key: "supply", label: "Supply", type: "text" },
          { key: "quantity", label: "Qty", type: "number" },
          { key: "taxable", label: "Taxable value", type: "money" },
          { key: "cgst", label: "CGST", type: "money" },
          { key: "sgst", label: "SGST", type: "money" },
          { key: "igst", label: "IGST", type: "money" },
          { key: "tax", label: "Total GST", type: "money" },
          { key: "total", label: "Invoice value", type: "money" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["quantity", "taxable", "cgst", "sgst", "igst", "tax", "total"]),
      };
    }
    case "suppliers": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT s.code, s.name, s.gstin, COUNT(DISTINCT po.id) AS orders, COALESCE(SUM(po.grand_total), 0) AS value,
               COALESCE(SUM((SELECT SUM(quantity_ordered) FROM purchase_order_items x WHERE x.purchase_order_id = po.id)), 0) AS ordered,
               COALESCE(SUM((SELECT SUM(quantity_received) FROM purchase_order_items x WHERE x.purchase_order_id = po.id)), 0) AS received
        FROM suppliers s LEFT JOIN purchase_orders po ON po.supplier_id = s.id AND po.status NOT IN ('DRAFT', 'CANCELLED') AND po.order_date >= ${from} AND po.order_date <= ${to}
        GROUP BY s.id ORDER BY value DESC`;
      const mapped = rows.map((r) => ({ ...r, orders: n(r.orders), value: n(r.value), ordered: n(r.ordered), received: n(r.received), pending: Math.max(0, n(r.ordered) - n(r.received)) }));
      return {
        ...base,
        title: "Supplier purchases",
        columns: [
          { key: "code", label: "Code", type: "text" },
          { key: "name", label: "Supplier", type: "text" },
          { key: "gstin", label: "GSTIN", type: "text" },
          { key: "orders", label: "POs", type: "number" },
          { key: "value", label: "Purchase value", type: "money" },
          { key: "ordered", label: "Qty ordered", type: "number" },
          { key: "received", label: "Qty received", type: "number" },
          { key: "pending", label: "Qty pending", type: "number" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["orders", "value", "ordered", "received", "pending"]),
      };
    }
    case "purchases": {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT po.number, po.order_date, s.name AS supplier, w.code AS warehouse, po.status, po.subtotal, po.tax_total, po.grand_total, po.expected_delivery_date
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id
        WHERE po.order_date >= ${from} AND po.order_date <= ${to} ORDER BY po.order_date DESC`;
      const mapped = rows.map((r) => ({ ...r, subtotal: n(r.subtotal), tax_total: n(r.tax_total), grand_total: n(r.grand_total) }));
      return {
        ...base,
        title: "Purchase orders",
        columns: [
          { key: "number", label: "PO", type: "text" },
          { key: "order_date", label: "Date", type: "date" },
          { key: "supplier", label: "Supplier", type: "text" },
          { key: "warehouse", label: "Warehouse", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "subtotal", label: "Subtotal", type: "money" },
          { key: "tax_total", label: "GST", type: "money" },
          { key: "grand_total", label: "Total", type: "money" },
          { key: "expected_delivery_date", label: "Expected", type: "date" },
        ],
        rows: mapped,
        totals: sumColumns(mapped, ["subtotal", "tax_total", "grand_total"]),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

function cell(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined) return "";
  if (type === "money") return (Number(v) / 100).toFixed(2);
  if (type === "date") return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function toCsv(r: Report): string {
  // Neutralise spreadsheet formula injection in text cells.
  const esc = (s: string) => {
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = r.columns.map((c) => esc(c.label + (c.type === "money" ? " (₹)" : ""))).join(",");
  const body = r.rows.map((row) => r.columns.map((c) => esc(cell(row[c.key], c.type))).join(","));
  return "﻿" + [header, ...body].join("\r\n"); // BOM so Excel reads UTF-8 (₹)
}

export async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Trendz";
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.columns = r.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length + 4), style: c.type === "money" ? { numFmt: "₹#,##0.00" } : {} }));
  for (const row of r.rows) {
    ws.addRow(Object.fromEntries(r.columns.map((c) => [c.key, c.type === "money" ? Number(row[c.key] ?? 0) / 100 : c.type === "number" || c.type === "percent" ? Number(row[c.key] ?? 0) : row[c.key] instanceof Date ? row[c.key] : (row[c.key] ?? "")])));
  }
  if (r.totals) {
    const t = ws.addRow(Object.fromEntries(r.columns.map((c, i) => [c.key, i === 0 ? "Total" : r.totals![c.key] !== undefined ? (c.type === "money" ? r.totals![c.key]! / 100 : r.totals![c.key]) : ""])));
    t.font = { bold: true };
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function toPdf(r: Report): Promise<Buffer> {
  const doc = createPdf({ size: "A4", layout: "landscape", margin: 28 });
  return renderPdf(doc, (d) => {
    const width = d.page.width - 56;
    d.font("bold").fontSize(14).text(r.title);
    d.font("regular").fontSize(8).fillColor("#555").text(`${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} · ${r.rows.length} rows`).fillColor("#111");
    d.moveDown();
    const colW = width / r.columns.length;
    const drawRow = (vals: string[], bold = false) => {
      if (d.y > d.page.height - 50) d.addPage();
      const y = d.y;
      d.font(bold ? "condensed-bold" : "condensed").fontSize(7);
      vals.forEach((v, i) => d.text(v, 28 + i * colW, y, { width: colW - 4, height: 18, ellipsis: true, align: ["money", "number", "percent"].includes(r.columns[i]!.type) ? "right" : "left" }));
      d.y = y + 14;
    };
    drawRow(r.columns.map((c) => c.label), true);
    for (const row of r.rows.slice(0, 5000)) drawRow(r.columns.map((c) => (c.type === "money" ? rupees(Number(row[c.key] ?? 0)) : cell(row[c.key], c.type))));
    if (r.totals) drawRow(r.columns.map((c, i) => (i === 0 ? "Total" : r.totals![c.key] !== undefined ? (c.type === "money" ? rupees(r.totals![c.key]!) : String(r.totals![c.key])) : "")), true);
  });
}
