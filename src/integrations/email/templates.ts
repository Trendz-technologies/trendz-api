import { env } from "../../config/env";
import { formatInr } from "../../common/utils/money";

/** Reusable transactional email templates. Data is always HTML-escaped. */

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }) {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${esc(cta.url)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f5f5f3;font-family:Inter,Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:20px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
<p style="letter-spacing:.25em;font-size:12px;font-weight:700;margin:0 0 24px">${esc(env.EMAIL_FROM_NAME.toUpperCase())}</p>
<h1 style="font-size:22px;margin:0 0 16px">${esc(title)}</h1>
${bodyHtml}${button}
<p style="color:#888;font-size:12px;margin-top:32px">You are receiving this email because of activity on your ${esc(env.EMAIL_FROM_NAME)} account.</p>
</td></tr></table></td></tr></table></body></html>`;
}

const p = (text: string) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${text}</p>`;

interface Line {
  name: string;
  variant: string;
  quantity: number;
  total: number;
}

function itemsTable(items: Line[]) {
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(i.name)}<br><span style="color:#888;font-size:13px">${esc(i.variant)} × ${i.quantity}</span></td><td align="right" style="padding:8px 0;border-bottom:1px solid #eee">${formatInr(i.total)}</td></tr>`,
    )
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">${rows}</table>`;
}

export interface EmailTemplateData {
  "auth.verify_email": { name?: string | null; url: string };
  "auth.password_reset": { name?: string | null; url: string };
  "order.confirmed": { name?: string | null; orderNumber: string; items: Line[]; grandTotal: number; url: string };
  "order.payment_received": { orderNumber: string; amount: number; method: string };
  "order.invoice": { orderNumber: string; invoiceNumber: string; url: string };
  "order.shipped": { orderNumber: string; courier?: string | null; awb?: string | null; trackingUrl?: string | null };
  "order.out_for_delivery": { orderNumber: string };
  "order.delivered": { orderNumber: string; reviewUrl?: string | null };
  "order.cancelled": { orderNumber: string; reason?: string | null; refundNote?: string | null };
  "order.refunded": { orderNumber: string; amount: number; refundNumber: string };
  "admin.new_order": { orderNumber: string; grandTotal: number; channel: string; url: string };
  "admin.low_stock": { items: { sku: string; name: string; warehouse: string; available: number; threshold: number }[] };
  "admin.alert": { title: string; message: string };
  "system.test": { sentAt: string };
}

export type EmailTemplate = keyof EmailTemplateData;

type Renderer<K extends EmailTemplate> = (d: EmailTemplateData[K]) => { subject: string; html: string; text: string };

const renderers: { [K in EmailTemplate]: Renderer<K> } = {
  "auth.verify_email": (d) => ({
    subject: "Verify your email address",
    html: layout(
      "Confirm your email",
      p(`Hi ${esc(d.name ?? "there")}, please confirm your email address to secure your account.`) +
        p("This link expires in 24 hours."),
      { label: "Verify email", url: d.url },
    ),
    text: `Confirm your email address: ${d.url} (expires in 24 hours)`,
  }),
  "auth.password_reset": (d) => ({
    subject: "Reset your password",
    html: layout(
      "Reset your password",
      p(`Hi ${esc(d.name ?? "there")}, we received a request to reset your password.`) +
        p("This link expires in 1 hour. If you did not request it, you can ignore this email."),
      { label: "Choose a new password", url: d.url },
    ),
    text: `Reset your password: ${d.url} (expires in 1 hour). If you did not request this, ignore this email.`,
  }),
  "order.confirmed": (d) => ({
    subject: `Order ${d.orderNumber} confirmed`,
    html: layout(
      "Thanks for your order!",
      p(`Hi ${esc(d.name ?? "there")}, your order <strong>${esc(d.orderNumber)}</strong> is confirmed.`) +
        itemsTable(d.items) +
        p(`<strong>Total: ${formatInr(d.grandTotal)}</strong>`),
      { label: "View order", url: d.url },
    ),
    text: `Order ${d.orderNumber} confirmed. Total ${formatInr(d.grandTotal)}. ${d.url}`,
  }),
  "order.payment_received": (d) => ({
    subject: `Payment received for ${d.orderNumber}`,
    html: layout("Payment received", p(`We received ${formatInr(d.amount)} via ${esc(d.method)} for order ${esc(d.orderNumber)}.`)),
    text: `Payment of ${formatInr(d.amount)} received for order ${d.orderNumber}.`,
  }),
  "order.invoice": (d) => ({
    subject: `Invoice ${d.invoiceNumber} for order ${d.orderNumber}`,
    html: layout(
      "Your invoice",
      p(`Invoice <strong>${esc(d.invoiceNumber)}</strong> for order ${esc(d.orderNumber)} is attached.`),
      { label: "View order", url: d.url },
    ),
    text: `Invoice ${d.invoiceNumber} for order ${d.orderNumber} is attached.`,
  }),
  "order.shipped": (d) => ({
    subject: `Order ${d.orderNumber} has shipped`,
    html: layout(
      "Your order is on its way",
      p(`Order ${esc(d.orderNumber)} has shipped${d.courier ? ` with ${esc(d.courier)}` : ""}.`) +
        (d.awb ? p(`Tracking number (AWB): <strong>${esc(d.awb)}</strong>`) : ""),
      d.trackingUrl ? { label: "Track shipment", url: d.trackingUrl } : undefined,
    ),
    text: `Order ${d.orderNumber} shipped. AWB ${d.awb ?? "-"}. ${d.trackingUrl ?? ""}`,
  }),
  "order.out_for_delivery": (d) => ({
    subject: `Order ${d.orderNumber} is out for delivery`,
    html: layout("Out for delivery", p(`Order ${esc(d.orderNumber)} will be delivered today.`)),
    text: `Order ${d.orderNumber} is out for delivery.`,
  }),
  "order.delivered": (d) => ({
    subject: `Order ${d.orderNumber} delivered`,
    html: layout(
      "Delivered",
      p(`Order ${esc(d.orderNumber)} has been delivered. Enjoy!`) + (d.reviewUrl ? p("We would love to know what you think. Rating your items takes a minute and helps other shoppers choose.") : ""),
      d.reviewUrl ? { label: "Rate and review", url: d.reviewUrl } : undefined,
    ),
    text: `Order ${d.orderNumber} has been delivered.` + (d.reviewUrl ? ` Rate and review your items: ${d.reviewUrl}` : ""),
  }),
  "order.cancelled": (d) => ({
    subject: `Order ${d.orderNumber} cancelled`,
    html: layout(
      "Order cancelled",
      p(`Order ${esc(d.orderNumber)} has been cancelled.`) +
        (d.reason ? p(`Reason: ${esc(d.reason)}`) : "") +
        (d.refundNote ? p(esc(d.refundNote)) : ""),
    ),
    text: `Order ${d.orderNumber} has been cancelled. ${d.refundNote ?? ""}`,
  }),
  "order.refunded": (d) => ({
    subject: `Refund processed for ${d.orderNumber}`,
    html: layout(
      "Refund processed",
      p(`A refund of <strong>${formatInr(d.amount)}</strong> (${esc(d.refundNumber)}) for order ${esc(d.orderNumber)} has been processed.`) +
        p("It can take 5–7 business days to reflect in your account."),
    ),
    text: `Refund of ${formatInr(d.amount)} processed for order ${d.orderNumber}.`,
  }),
  "admin.new_order": (d) => ({
    subject: `New ${d.channel} order ${d.orderNumber} — ${formatInr(d.grandTotal)}`,
    html: layout("New order", p(`Order ${esc(d.orderNumber)} (${esc(d.channel)}) for ${formatInr(d.grandTotal)}.`), {
      label: "Open in admin",
      url: d.url,
    }),
    text: `New order ${d.orderNumber} for ${formatInr(d.grandTotal)}: ${d.url}`,
  }),
  "admin.low_stock": (d) => ({
    subject: `Low stock: ${d.items.length} SKU(s) need attention`,
    html: layout(
      "Low stock alert",
      `<table width="100%" style="font-size:13px" cellpadding="4">${d.items
        .map(
          (i) =>
            `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${esc(i.warehouse)}</td><td align="right">${i.available} / ${i.threshold}</td></tr>`,
        )
        .join("")}</table>`,
    ),
    text: d.items.map((i) => `${i.sku} ${i.name} @ ${i.warehouse}: ${i.available} (threshold ${i.threshold})`).join("\n"),
  }),
  "admin.alert": (d) => ({
    subject: d.title,
    html: layout(d.title, p(esc(d.message))),
    text: `${d.title}\n\n${d.message}`,
  }),
  "system.test": (d) => ({
    subject: "Test email",
    html: layout("Email delivery works", p(`Sent at ${esc(d.sentAt)}.`)),
    text: `Email delivery works. Sent at ${d.sentAt}.`,
  }),
};

export function renderEmail<K extends EmailTemplate>(template: K, data: EmailTemplateData[K]) {
  return (renderers[template] as Renderer<K>)(data);
}

export const isEmailTemplate = (t: string): t is EmailTemplate => t in renderers;
