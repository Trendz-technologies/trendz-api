import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { closeQueues, getQueue } from "../src/jobs/queues";
import { issueInvoice, renderInvoicePdf } from "../src/modules/invoices/invoices.service";
import { expireUnpaidOrders, ingestWebhook, processWebhookEvent } from "../src/modules/payments/payments.service";
import { mockGateway } from "../src/integrations/razorpay";
import { webhookSignature } from "../src/integrations/razorpay/gateway.types";
import { client, loginAs, resetDatabase, type TestClient } from "./helpers";
import { addAddress, level, makeProduct } from "./fixtures";

beforeEach(resetDatabase);
afterAll(closeQueues);

let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}`;

function placeOrder(c: TestClient, addressId: string, idem = key(), extra: object = {}) {
  return c.post("/api/orders").set("Idempotency-Key", idem).send({ shippingAddressId: addressId, ...extra });
}

/** Runs queued webhook jobs the way the worker would. */
async function drainWebhooks() {
  const jobs = await getQueue("webhooks").getJobs(["waiting", "prioritized", "delayed"]);
  for (const j of jobs) {
    await processWebhookEvent(j.data.webhookEventId);
    await j.remove();
  }
}

async function payWithMock(c: TestClient, orderId: string, outcome: "success" | "failure" = "success") {
  const pay = await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId }).expect(200);
  const sim = await c.post("/api/payments/mock/complete").send({ razorpayOrderId: pay.body.data.razorpayOrderId, outcome }).expect(200);
  return { pay: pay.body.data, sim: sim.body.data };
}

describe("checkout", () => {
  it("cart → quote → order (stock reserved, idempotent) → pay → confirmed (stock sold)", async () => {
    const { variant } = await makeProduct({ name: "Linen Shirt", price: 79900, stock: 3 });
    const { client: c, user } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c, "Karnataka");

    const cart = await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 2 }).expect(200);
    expect(cart.body.data).toMatchObject({ itemCount: 2, subtotal: 159800, grandTotal: 159800 });

    const quote = await c.post("/api/checkout/quote").send({ shippingAddressId: address.id }).expect(200);
    expect(quote.body.data).toMatchObject({ canPlaceOrder: true, interState: true, placeOfSupply: "29" });
    expect(quote.body.data.igstTotal).toBeGreaterThan(0);

    const idem = key();
    const first = await placeOrder(c, address.id, idem, { expectedGrandTotal: quote.body.data.grandTotal }).expect(201);
    const replay = await placeOrder(c, address.id, idem, { expectedGrandTotal: quote.body.data.grandTotal }).expect(201);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await prisma.order.count()).toBe(1);

    const order = first.body.data;
    expect(order).toMatchObject({ status: "PENDING", paymentStatus: "CREATED", grandTotal: 159800, canPay: true });
    expect(order.orderNumber).toMatch(/^ORD-\d{8}-0001$/);
    expect(await level(variant.id)).toMatchObject({ onHand: 3, reserved: 2 });
    expect((await c.get("/api/cart").expect(200)).body.data.itemCount).toBe(0);

    const { sim } = await payWithMock(c, order.id);
    const verified = await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);
    expect(verified.body.data).toMatchObject({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await level(variant.id)).toMatchObject({ onHand: 1, reserved: 0 });

    // The signed webhook for the same payment changes nothing (idempotent).
    await drainWebhooks();
    expect(await prisma.webhookEvent.count({ where: { status: "PROCESSED" } })).toBe(1);
    expect(await level(variant.id)).toMatchObject({ onHand: 1, reserved: 0 });
    const ledger = await prisma.inventoryTransaction.findMany({ where: { variantId: variant.id, type: "SALE" } });
    expect(ledger.map((l) => [l.bucket, l.quantity])).toEqual(expect.arrayContaining([["RESERVED", -2], ["ON_HAND", -2]]));
    expect(ledger).toHaveLength(2);

    const detail = await c.get(`/api/account/orders/${order.orderNumber}`).expect(200);
    expect(detail.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(["PENDING", "CONFIRMED"]);
    expect(await prisma.notification.count({ where: { userId: user.id, template: "order.confirmed" } })).toBe(1);
  });

  it("rejects tampered signatures and forged webhooks", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 2 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 1 }).expect(200);
    const order = (await placeOrder(c, address.id).expect(201)).body.data;
    const { sim } = await payWithMock(c, order.id);

    const tampered = await c.post("/api/payments/verify").send({ ...sim.checkoutResponse, razorpay_signature: "0".repeat(64) }).expect(422);
    expect(tampered.body.code).toBe("PAYMENT_VERIFICATION_FAILED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).not.toBe("PAID");

    const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: {} }));
    await expect(ingestWebhook(body, "bad", "evt_1")).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });

    // Same event id twice → stored once.
    const signed = webhookSignature("test_webhook_secret", body);
    await ingestWebhook(body, signed, "evt_dup");
    const again = await ingestWebhook(body, signed, "evt_dup");
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_dup" } })).toBe(1);
    expect(again.received).toBe(true);
  });

  it("a failed payment keeps the order payable; expiry releases the stock", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 2 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 2 }).expect(200);
    const order = (await placeOrder(c, address.id).expect(201)).body.data;

    await payWithMock(c, order.id, "failure");
    await drainWebhooks();
    const afterFail = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFail).toMatchObject({ status: "PENDING", paymentStatus: "FAILED" });
    expect(await level(variant.id)).toMatchObject({ reserved: 2 });

    await prisma.order.update({ where: { id: order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await prisma.stockReservation.updateMany({ where: { orderId: order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireUnpaidOrders()).toEqual({ expired: 1 });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CANCELLED", paymentStatus: "FAILED" });
    expect(await level(variant.id)).toMatchObject({ onHand: 2, reserved: 0 });
    await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId: order.id }).expect(409);
  });

  it("two customers racing for the last unit: exactly one order succeeds", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 1 });
    const buyers = await Promise.all([loginAs(["CUSTOMER"]), loginAs(["CUSTOMER"]), loginAs(["CUSTOMER"])]);
    const addresses: { id: string }[] = [];
    for (const b of buyers) {
      addresses.push(await addAddress(b.client));
      await b.client.post("/api/cart/items").send({ variantId: variant.id, quantity: 1 }).expect(200);
    }
    const results = await Promise.all(buyers.map((b, i) => placeOrder(b.client, addresses[i]!.id)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "OUT_OF_STOCK")).toBe(true);
    expect(await level(variant.id)).toMatchObject({ onHand: 1, reserved: 1 });
  });

  it("refuses to place an order when the price changed since the quote", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 5 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 1 }).expect(200);
    const quote = (await c.post("/api/checkout/quote").send({ shippingAddressId: address.id }).expect(200)).body.data;
    await prisma.productVariant.update({ where: { id: variant.id }, data: { sellingPrice: 45000 } });
    const res = await placeOrder(c, address.id, key(), { expectedGrandTotal: quote.grandTotal }).expect(409);
    expect(res.body.code).toBe("PRICE_CHANGED");
  });

  it("merges a guest cart into the customer cart at sign-in", async () => {
    const { variant } = await makeProduct({ price: 50000, stock: 5 });
    const guest = await client();
    await guest.post("/api/cart/items").send({ variantId: variant.id, quantity: 2 }).expect(200);
    const { client: _ignored, user } = await loginAs(["CUSTOMER"]);
    await guest.post("/api/auth/login").send({ identifier: user.email, password: user.password }).expect(200);
    expect((await guest.get("/api/cart").expect(200)).body.data.itemCount).toBe(2);
  });
});

describe("billing, cancellation and refunds", () => {
  it("issues an immutable invoice; cancelling a paid order restocks, refunds and issues a credit note", async () => {
    const { variant } = await makeProduct({ price: 79900, stock: 5 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 2 }).expect(200);
    const order = (await placeOrder(c, address.id).expect(201)).body.data;
    const { sim } = await payWithMock(c, order.id);
    await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);

    const invoice = await issueInvoice(order.id);
    expect(invoice.invoiceNumber).toMatch(/^INV\/\d{4}\/000001$/);
    expect(invoice.invoiceNumber.length).toBeLessThanOrEqual(16); // GST limit
    expect((await issueInvoice(order.id)).id).toBe(invoice.id); // idempotent
    expect(invoice.cgstTotal + invoice.sgstTotal).toBe(order.taxTotal);
    const pdf = await renderInvoicePdf(invoice);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await expect(prisma.$executeRaw`UPDATE invoices SET grand_total = 1`).rejects.toThrow(/immutable/);

    const cancelled = await c.post(`/api/account/orders/${order.orderNumber}/cancel`).send({ reason: "Ordered the wrong size" }).expect(200);
    expect(cancelled.body.data).toMatchObject({ status: "REFUNDED", paymentStatus: "REFUNDED", amountRefunded: order.grandTotal });
    expect(await level(variant.id)).toMatchObject({ onHand: 5, reserved: 0 });

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund).toMatchObject({ status: "PROCESSED", amount: order.grandTotal });
    expect(refund.razorpayRefundId).toMatch(/^rfnd_mock/);
    const cn = await prisma.creditNote.findFirstOrThrow({ where: { refundId: refund.id } });
    expect(cn.total).toBe(order.grandTotal);
    expect(cn.creditNoteNumber).toMatch(/^CN\//);

    // Cancelling again does nothing harmful.
    await c.post(`/api/account/orders/${order.orderNumber}/cancel`).send({ reason: "again" }).expect(409);
    expect(await prisma.refund.count()).toBe(1);
  });

  it("staff partial refunds respect the refundable balance", async () => {
    const { variant } = await makeProduct({ price: 100000, stock: 5 });
    const { client: c } = await loginAs(["CUSTOMER"]);
    const address = await addAddress(c);
    await c.post("/api/cart/items").send({ variantId: variant.id, quantity: 1 }).expect(200);
    const order = (await placeOrder(c, address.id).expect(201)).body.data;
    const { sim } = await payWithMock(c, order.id);
    await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);

    const { client: admin } = await loginAs(["ADMIN"]);
    await admin.post("/api/refunds").set("Idempotency-Key", key()).send({ orderId: order.id, amount: 30000, reason: "Goodwill" }).expect(201);
    const over = await admin.post("/api/refunds").set("Idempotency-Key", key()).send({ orderId: order.id, amount: order.grandTotal, reason: "Too much" }).expect(400);
    expect(over.body.message).toMatch(/At most/);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ paymentStatus: "PARTIALLY_REFUNDED", amountRefunded: 30000, status: "CONFIRMED" });
    expect(mockGateway()).not.toBeNull();
  });
});
