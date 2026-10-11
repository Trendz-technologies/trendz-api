import { env, isProduction } from "../../config/env";
import type { PaymentGateway } from "./gateway.types";
import { MockPaymentGateway } from "./mock/mock.gateway";
import { RazorpayGateway } from "./razorpay.gateway";

let gateway: PaymentGateway | null = null;

/** The configured payment gateway. Business code depends only on PaymentGateway. */
export function paymentGateway(): PaymentGateway {
  if (gateway) return gateway;
  if (env.PAYMENT_PROVIDER === "razorpay") {
    gateway = new RazorpayGateway(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET!, env.RAZORPAY_WEBHOOK_SECRET);
  } else {
    if (isProduction) throw new Error("The mock payment gateway cannot run in production");
    gateway = new MockPaymentGateway(env.RAZORPAY_KEY_SECRET ?? "mock_key_secret_for_local_development", env.RAZORPAY_WEBHOOK_SECRET ?? "mock_webhook_secret");
  }
  return gateway;
}

export function mockGateway(): MockPaymentGateway | null {
  const g = paymentGateway();
  return g instanceof MockPaymentGateway ? g : null;
}

export type { PaymentGateway, GatewayPayment } from "./gateway.types";
