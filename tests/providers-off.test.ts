import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// No payment gateway and no courier service connected: set before any application module loads.
vi.hoisted(() => {
  process.env.PAYMENT_PROVIDER = "none";
  process.env.SHIPPING_PROVIDER = "none";
});

import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import { expireUnpaidOrders, reconcileOpenPayments } from "../src/modules/payments/payments.service";
import { updateSetting } from "../src/modules/settings/settings.service";
import { syncActiveShipments } from "../src/modules/shipping/shipping.service";
import { client, loginAs, resetDatabase } from "./helpers";
import { addAddress, level, makeProduct } from "./fixtures";

beforeEach(resetDatabase);
afterAll(closeQueues);

let keySeq = 0;
const key = () => `off-${Date.now()}-${++keySeq}`;

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

    const placed = await c.post("/api/orders").set("Idempotency-Key", key()).send({ shippingAddressId: address.id }).expect(503);
    expect(placed.body.code).toBe("ONLINE_ORDERS_UNAVAILABLE");
    expect(await prisma.order.count()).toBe(0);
    expect(await level(variant.id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect((await c.get("/api/cart").expect(200)).body.data.itemCount).toBe(2);
  });

  it("starts no payment and simulates none", async () => {
    const { client: c } = await loginAs(["CUSTOMER"]);
    const orderId = "00000000-0000-4000-8000-000000000000";
    const create = await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId }).expect(503);
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

  it("does not refund, or cancel on the promise of a refund, an order that was paid through the gateway", async () => {
    // A counter sale, turned into what an online order paid before the gateway was disconnected looks like.
    const { variant, sku } = await makeProduct({ name: "Tee", price: 79900, stock: 5 });
    const wh = await prisma.warehouse.findFirstOrThrow({ where: { code: "WH-001" } });
    const cashier = await loginAs(["CASHIER"], { warehouseId: wh.id });
    const cart = (await cashier.client.post("/api/pos/carts").send({ warehouseId: wh.id }).expect(201)).body.data;
    await cashier.client.post(`/api/pos/carts/${cart.id}/scan`).send({ code: sku }).expect(200);
    await cashier.client.post(`/api/pos/carts/${cart.id}/checkout`).set("Idempotency-Key", key()).send({ paymentMethod: "CASH", amountTendered: 79900 }).expect(200);
    const order = await prisma.order.findFirstOrThrow();
    await prisma.payment.updateMany({ where: { orderId: order.id }, data: { provider: "RAZORPAY", razorpayOrderId: "order_before_disconnect", razorpayPaymentId: "pay_before_disconnect" } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const stock = await level(variant.id);

    const admin = await loginAs(["SUPER_ADMIN"]);
    const refund = await admin.client.post("/api/refunds").set("Idempotency-Key", key()).send({ orderId: order.id, reason: "Customer changed their mind" }).expect(503);
    expect(refund.body.code).toBe("PAYMENTS_UNAVAILABLE");
    expect(await prisma.refund.count()).toBe(0);

    const cancel = await admin.client.post(`/api/orders/${order.id}/cancel`).send({ reason: "Requested by the customer" }).expect(503);
    expect(cancel.body.code).toBe("PAYMENTS_UNAVAILABLE");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await level(variant.id)).toMatchObject({ onHand: stock.onHand, reserved: stock.reserved });
  });
});

describe("no courier service connected (SHIPPING_PROVIDER=none)", () => {
  it("uses the flat shipping rate even when courier rates are switched on in Settings", async () => {
    const shipping = await updateSetting("shipping", { mode: "PROVIDER_RATES" }, systemContext);
    const { variant } = await makeProduct({ name: "Scarf", price: 49900, stock: 5 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 1 }).expect(200);

    const quote = await c.post("/api/checkout/quote").send({ shippingAddressId: address.id }).expect(200);
    expect(quote.body.data.shipping).toMatchObject({ amount: shipping.flatRate, free: false });
    const rates = await c.post("/api/shipping/rates").send({ postalCode: "600001" }).expect(200);
    expect(rates.body.data).toMatchObject({ serviceable: true, amount: shipping.flatRate });
  });

  it("books no courier, and says so", async () => {
    const { shippingService } = await import("../src/integrations/shipping/index.js");
    expect(() => shippingService()).toThrow(/No courier service is connected yet/);
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
