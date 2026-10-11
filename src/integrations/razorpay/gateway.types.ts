import crypto from "node:crypto";
import { safeEqual } from "../../common/utils/crypto";

export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

export type GatewayPaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  status: GatewayPaymentStatus;
  amount: number;
  currency: string;
  method: string | null;
  amountRefunded: number;
  errorDescription: string | null;
}

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amount: number;
  status: "pending" | "processed" | "failed";
}

/** Everything the platform needs from a payment provider. */
export interface PaymentGateway {
  readonly name: "razorpay" | "mock";
  /** Public key for the browser checkout. Never the secret. */
  readonly keyId: string;
  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  capturePayment(paymentId: string, amount: number, currency: string): Promise<GatewayPayment>;
  refund(paymentId: string, input: { amount: number; receipt: string; notes: Record<string, string> }): Promise<GatewayRefund>;
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  /** All refunds of a payment with their notes; used to find a refund that went through although our call failed (e.g. a timeout). */
  listRefunds(paymentId: string): Promise<(GatewayRefund & { notes: Record<string, string> })[]>;
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

/** Razorpay's documented scheme: HMAC-SHA256(order_id + "|" + payment_id, key_secret). */
export function paymentSignature(secret: string, orderId: string, paymentId: string): string {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

/** Webhooks: HMAC-SHA256(raw request body, webhook_secret). */
export function webhookSignature(secret: string, rawBody: Buffer): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export const signaturesMatch = (expected: string, actual: string) => !!actual && safeEqual(expected, actual);
