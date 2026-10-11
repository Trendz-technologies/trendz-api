import { randomBytes } from "node:crypto";
import { redis } from "../../../database/redis";
import {
  paymentSignature,
  signaturesMatch,
  webhookSignature,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from "../gateway.types";

/**
 * DEVELOPMENT ONLY — refused in production by config/env.ts.
 *
 * Simulates Razorpay so checkout can be exercised without an account. Orders
 * and payments are kept in Redis, and signatures use exactly the same HMAC
 * scheme as Razorpay, so the real verification code paths run unchanged.
 */
export const MOCK_KEY_ID = "rzp_test_mock";
const id = (prefix: string) => `${prefix}_mock${randomBytes(7).toString("hex")}`;
const TTL = 7 * 24 * 3600;
const NEXT_REFUND_FAILURE_KEY = "mockpg:next-refund-failure";

interface MockOrder extends GatewayOrder {
  payments: string[];
}

export class MockPaymentGateway implements PaymentGateway {
  readonly name = "mock" as const;
  readonly keyId = MOCK_KEY_ID;

  constructor(
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  private setJson(key: string, value: unknown) {
    return redis.set(key, JSON.stringify(value), "EX", TTL);
  }

  async createOrder(input: { amount: number; currency: string; receipt: string }) {
    const order: MockOrder = { id: id("order"), amount: input.amount, currency: input.currency, receipt: input.receipt, status: "created", payments: [] };
    await this.setJson(`mockpg:order:${order.id}`, order);
    return order;
  }

  async fetchPayment(paymentId: string) {
    const p = await this.getJson<GatewayPayment>(`mockpg:payment:${paymentId}`);
    if (!p) throw new Error(`Mock payment ${paymentId} not found`);
    return p;
  }

  async fetchOrderPayments(orderId: string) {
    const o = await this.getJson<MockOrder>(`mockpg:order:${orderId}`);
    if (!o) return [];
    return Promise.all(o.payments.map((p) => this.fetchPayment(p)));
  }

  async capturePayment(paymentId: string) {
    const p = await this.fetchPayment(paymentId);
    if (p.status === "authorized") {
      p.status = "captured";
      await this.setJson(`mockpg:payment:${paymentId}`, p);
    }
    return p;
  }

  async refund(paymentId: string, input: { amount: number; notes?: Record<string, string> }): Promise<GatewayRefund> {
    // Simulated failures (see simulateNextRefundFailure): rejected outright, or processed but the response is lost.
    const failure = await redis.getdel(NEXT_REFUND_FAILURE_KEY);
    if (failure === "reject") throw Object.assign(new Error("Refund rejected"), { error: { description: "Refund rejected by the bank (simulated)" } });
    const p = await this.fetchPayment(paymentId);
    if (p.amountRefunded + input.amount > p.amount) throw new Error("Refund amount exceeds captured amount");
    p.amountRefunded += input.amount;
    p.status = p.amountRefunded === p.amount ? "refunded" : p.status;
    await this.setJson(`mockpg:payment:${paymentId}`, p);
    const refund = { id: id("rfnd"), paymentId, amount: input.amount, status: "processed" as const, notes: input.notes ?? {} };
    await this.setJson(`mockpg:refund:${refund.id}`, refund);
    await redis.rpush(`mockpg:payment-refunds:${paymentId}`, refund.id);
    await redis.expire(`mockpg:payment-refunds:${paymentId}`, TTL);
    if (failure === "lost-response") throw new Error("Gateway timeout (simulated)");
    const { notes: _notes, ...view } = refund;
    return view;
  }

  async fetchRefund(_paymentId: string, refundId: string) {
    const r = await this.getJson<GatewayRefund>(`mockpg:refund:${refundId}`);
    if (!r) throw new Error(`Mock refund ${refundId} not found`);
    return r;
  }

  async listRefunds(paymentId: string) {
    const ids = await redis.lrange(`mockpg:payment-refunds:${paymentId}`, 0, -1);
    const rows = await Promise.all(ids.map((rid) => this.getJson<GatewayRefund & { notes: Record<string, string> }>(`mockpg:refund:${rid}`)));
    return rows.filter((r): r is GatewayRefund & { notes: Record<string, string> } => !!r);
  }

  /** Makes the next refund call fail: "reject" (nothing refunded) or "lost-response" (refunded, but the caller sees an error). */
  static simulateNextRefundFailure(mode: "reject" | "lost-response") {
    return redis.set(NEXT_REFUND_FAILURE_KEY, mode, "EX", 600);
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }) {
    return signaturesMatch(paymentSignature(this.keySecret, input.orderId, input.paymentId), input.signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string) {
    return signaturesMatch(webhookSignature(this.webhookSecret, rawBody), signature);
  }

  // ---- simulation helpers (what Razorpay's popup + servers would do) -------

  /** Simulates the customer completing (or failing) payment in the checkout popup. */
  async simulateCheckout(orderId: string, outcome: "success" | "failure", method = "upi") {
    const o = await this.getJson<MockOrder>(`mockpg:order:${orderId}`);
    if (!o) throw new Error(`Mock order ${orderId} not found`);
    const payment: GatewayPayment = {
      id: id("pay"),
      orderId,
      status: outcome === "success" ? "captured" : "failed",
      amount: o.amount,
      currency: o.currency,
      method,
      amountRefunded: 0,
      errorDescription: outcome === "success" ? null : "Payment declined by the bank (simulated)",
    };
    o.payments.push(payment.id);
    if (outcome === "success") o.status = "paid";
    await this.setJson(`mockpg:payment:${payment.id}`, payment);
    await this.setJson(`mockpg:order:${orderId}`, o);
    return {
      payment,
      checkoutResponse:
        outcome === "success"
          ? { razorpay_order_id: orderId, razorpay_payment_id: payment.id, razorpay_signature: paymentSignature(this.keySecret, orderId, payment.id) }
          : null,
    };
  }

  /** Builds a signed webhook body exactly like Razorpay would send. */
  signedWebhook(event: string, payment: GatewayPayment) {
    const body = Buffer.from(
      JSON.stringify({
        entity: "event",
        event,
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: payment.id,
              order_id: payment.orderId,
              status: payment.status,
              amount: payment.amount,
              currency: payment.currency,
              method: payment.method,
              error_description: payment.errorDescription,
            },
          },
        },
      }),
    );
    return { body, signature: webhookSignature(this.webhookSecret, body), eventId: id("evt") };
  }
}
