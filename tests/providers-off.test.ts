import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// No payment gateway and no courier service connected: set before any application module loads.
vi.hoisted(() => {
  process.env.PAYMENT_PROVIDER = "none";
  process.env.SHIPPING_PROVIDER = "none";
});

import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { expireUnpaidOrders, reconcileOpenPayments } from "../src/modules/payments/payments.service";
import { syncActiveShipments } from "../src/modules/shipping/shipping.service";
import { client, loginAs, resetDatabase } from "./helpers";
import { addAddress, level, makeProduct } from "./fixtures";

beforeEach(resetDatabase);
afterAll(closeQueues);

describe("no payment gateway connected (PAYMENT_PROVIDER=none)", () => {
  it("tells the storefront, and takes no online order", async () => {
    const config = await (await client()).get("/api/store/config").expect(200);
    expect(config.body.data.payments).toEqual({ provider: "none", razorpayKeyId: null });

    const { variant } = await makeProduct({ name: "Linen Shirt", price: 79900, stock: 3 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 2 }).expect(200);

    // The bag and the totals still work; the order itself is refused, and no stock is held for it.
    const quote = await c.post("/api/checkout/quote").send({ shippingAddressId: address.id }).expect(200);
    expect(quote.body.data).toMatchObject({ canPlaceOrder: false, issues: [], grandTotal: 159800 });

    const placed = await c.post("/api/orders").set("Idempotency-Key", `off-${Date.now()}`).send({ shippingAddressId: address.id }).expect(503);
    expect(placed.body.code).toBe("ONLINE_ORDERS_UNAVAILABLE");
    expect(await prisma.order.count()).toBe(0);
    expect(await level(variant.id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect((await c.get("/api/cart").expect(200)).body.data.itemCount).toBe(2);
  });

  it("starts no payment and simulates none", async () => {
    const { client: c } = await loginAs(["CUSTOMER"]);
    const orderId = "00000000-0000-4000-8000-000000000000";
    const create = await c.post("/api/payments/create").set("Idempotency-Key", `off-${Date.now()}`).send({ orderId }).expect(503);
    expect(create.body.code).toBe("PAYMENTS_UNAVAILABLE");
    const mock = await c.post("/api/payments/mock/complete").send({ razorpayOrderId: "order_x", outcome: "success" }).expect(503);
    expect(mock.body.code).toBe("PAYMENTS_UNAVAILABLE");
    expect(await prisma.payment.count()).toBe(0);
  });

  it("leaves the gateway out of the billing counter's payment methods", async () => {
    const cashier = await loginAs(["CASHIER"]);
    const config = await cashier.client.get("/api/pos/config").expect(200);
    expect(config.body.data.enabledPaymentMethods).toEqual(["CASH", "UPI_MANUAL"]);
  });

  it("the scheduled jobs that ask a gateway or a courier do nothing", async () => {
    expect(await expireUnpaidOrders()).toEqual({ expired: 0 });
    expect(await reconcileOpenPayments()).toEqual({ checked: 0, paid: 0 });
    expect(await syncActiveShipments()).toEqual({ synced: 0, total: 0 });
  });
});

describe("production settings", () => {
  // Loads the settings afresh with other values, the way a new process would, and puts everything back.
  const load = async (vars: Record<string, string>) => {
    const changed: Record<string, string> = {
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      SMS_PROVIDER: "msg91",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_URL: "",
      CLOUDINARY_CLOUD_NAME: "my-shop",
      CLOUDINARY_API_KEY: "123456789012345",
      CLOUDINARY_API_SECRET: "AbCd-EfGh_IjKlMnOpQrStUvWx",
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
      RAZORPAY_WEBHOOK_SECRET: "",
      SHIPPING_WEBHOOK_TOKEN: "",
      ...vars,
    };
    const before = Object.fromEntries(Object.keys(changed).map((name) => [name, process.env[name]]));
    Object.assign(process.env, changed);
    vi.resetModules();
    try {
      return (await import("../src/config/env.js")).env;
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("start with no gateway and no courier connected, and with no keys for them", async () => {
    const env = await load({ PAYMENT_PROVIDER: "none", SHIPPING_PROVIDER: "none" });
    expect([env.NODE_ENV, env.PAYMENT_PROVIDER, env.SHIPPING_PROVIDER]).toEqual(["production", "none", "none"]);
  });

  it("still refuse the mock gateway and the mock courier", async () => {
    await expect(load({ PAYMENT_PROVIDER: "mock", SHIPPING_PROVIDER: "none" })).rejects.toThrow(/PAYMENT_PROVIDER=mock is not allowed in production/);
    await expect(load({ PAYMENT_PROVIDER: "none", SHIPPING_PROVIDER: "mock" })).rejects.toThrow(/SHIPPING_PROVIDER=mock is not allowed in production/);
  });

  it("still need the gateway's keys once Razorpay is selected", async () => {
    await expect(load({ PAYMENT_PROVIDER: "razorpay", SHIPPING_PROVIDER: "none" })).rejects.toThrow(/RAZORPAY_WEBHOOK_SECRET is required/);
  });
});
