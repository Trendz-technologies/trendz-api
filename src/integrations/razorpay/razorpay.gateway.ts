import Razorpay from "razorpay";
import { paymentSignature, signaturesMatch, webhookSignature, type GatewayPayment, type GatewayRefund, type PaymentGateway } from "./gateway.types";

interface RzpPayment {
  id: string;
  order_id: string | null;
  status: string;
  amount: number | string;
  currency: string;
  method?: string | null;
  amount_refunded?: number | string | null;
  error_description?: string | null;
}

interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number | string;
  status: string;
}

const toPayment = (p: RzpPayment): GatewayPayment => ({
  id: p.id,
  orderId: p.order_id ?? null,
  status: p.status as GatewayPayment["status"],
  amount: Number(p.amount),
  currency: p.currency,
  method: p.method ?? null,
  amountRefunded: Number(p.amount_refunded ?? 0),
  errorDescription: p.error_description ?? null,
});

const toRefund = (r: RzpRefund): GatewayRefund => ({
  id: r.id,
  paymentId: r.payment_id,
  amount: Number(r.amount),
  status: r.status === "processed" ? "processed" : r.status === "failed" ? "failed" : "pending",
});

/** Production adapter for Razorpay (https://razorpay.com/docs/api/). */
export class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay" as const;
  private readonly client: Razorpay;

  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  async createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) {
    const o = await this.client.orders.create({ amount: input.amount, currency: input.currency, receipt: input.receipt.slice(0, 40), notes: input.notes });
    return { id: o.id, amount: Number(o.amount), currency: o.currency, receipt: o.receipt ?? null, status: o.status };
  }

  async fetchPayment(paymentId: string) {
    return toPayment((await this.client.payments.fetch(paymentId)) as unknown as RzpPayment);
  }

  async fetchOrderPayments(orderId: string) {
    const res = (await this.client.orders.fetchPayments(orderId)) as unknown as { items: RzpPayment[] };
    return res.items.map(toPayment);
  }

  async capturePayment(paymentId: string, amount: number, currency: string) {
    return toPayment((await this.client.payments.capture(paymentId, amount, currency)) as unknown as RzpPayment);
  }

  async refund(paymentId: string, input: { amount: number; receipt: string; notes: Record<string, string> }) {
    const r = await this.client.payments.refund(paymentId, { amount: input.amount, receipt: input.receipt.slice(0, 40), notes: input.notes, speed: "normal" });
    return toRefund(r as unknown as RzpRefund);
  }

  async fetchRefund(paymentId: string, refundId: string) {
    return toRefund((await this.client.payments.fetchRefund(paymentId, refundId)) as unknown as RzpRefund);
  }

  async listRefunds(paymentId: string) {
    const res = (await this.client.payments.fetchMultipleRefund(paymentId, { count: 100 })) as unknown as { items: (RzpRefund & { notes?: unknown })[] };
    // Razorpay returns `notes` as [] when empty.
    return res.items.map((r) => ({ ...toRefund(r), notes: r.notes && !Array.isArray(r.notes) ? (r.notes as Record<string, string>) : {} }));
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }) {
    return signaturesMatch(paymentSignature(this.keySecret, input.orderId, input.paymentId), input.signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string) {
    if (!this.webhookSecret) return false; // refuse unsigned webhooks when no secret is configured
    return signaturesMatch(webhookSignature(this.webhookSecret, rawBody), signature);
  }
}
