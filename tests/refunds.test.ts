import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { redis } from "../src/database/redis";
import { closeQueues } from "../src/jobs/queues";
import { MockPaymentGateway } from "../src/integrations/razorpay/mock/mock.gateway";
import { loginAs, resetDatabase } from "./helpers";
import { addAddress, makeProduct } from "./fixtures";

beforeEach(async () => {
  await resetDatabase();
  await redis.del("mockpg:next-refund-failure");
});
afterAll(closeQueues);

let n = 0;
const key = () => `rf-${Date.now()}-${++n}`;

/** A Razorpay-paid (mock gateway) online order. */
async function paidOrder(qty = 2, price = 100000) {
  const { variant } = await makeProduct({ price, stock: 10 });
  const customer = await loginAs(["CUSTOMER"]);
  const c = customer.client;
  const address = await addAddress(c);
  await c.post("/api/cart/items").send({ variantId: variant.id, quantity: qty }).expect(200);
  const order = (await c.post("/api/orders").set("Idempotency-Key", key()).send({ shippingAddressId: address.id }).expect(201)).body.data;
  const pay = (await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId: order.id }).expect(200)).body.data;
  const sim = (await c.post("/api/payments/mock/complete").send({ razorpayOrderId: pay.razorpayOrderId }).expect(200)).body.data;
  await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);
  return { order };
}

async function receivedReturn(orderId: string, orderItemId: string, quantity: number) {
  await prisma.order.update({ where: { id: orderId }, data: { status: "DELIVERED", deliveredAt: new Date() } });
  const { client: admin } = await loginAs(["ADMIN"]);
  const rr = (await admin.post("/api/returns").send({ orderId, reason: "Wrong size", approve: true, items: [{ orderItemId, quantity }] }).expect(201)).body.data;
  await admin.post(`/api/returns/${rr.id}/receive`).send({ items: [{ returnItemId: rr.items[0].id, condition: "GOOD" }] }).expect(200);
  return { admin, rr };
}

const payment = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId, status: { not: "CREATED" } } });

describe("return refunds", () => {
  it("a gateway failure leaves the return unrefunded; retry pays exactly once and blocks further refunds", async () => {
    const { order } = await paidOrder(2);
    const { admin, rr } = await receivedReturn(order.id, order.items[0].id, 1);
    const value = Math.round(order.items[0].lineTotal / 2);

    await MockPaymentGateway.simulateNextRefundFailure("reject");
    const failed = await admin.post(`/api/returns/${rr.id}/refund`).set("Idempotency-Key", key()).send({}).expect(502);
    expect(failed.body.code).toBe("REFUND_FAILED");
    expect((await prisma.returnRequest.findUniqueOrThrow({ where: { id: rr.id } })).status).toBe("RECEIVED");
    const refund = await prisma.refund.findFirstOrThrow({ where: { returnRequestId: rr.id } });
    expect(refund).toMatchObject({ status: "FAILED", amount: value });
    expect((await payment(order.id)).amountRefunded).toBe(0);
    expect((await admin.get(`/api/returns/${rr.id}`).expect(200)).body.data.refundableAmount).toBe(value);

    // Retry reuses the same record and number.
    const retried = (await admin.post(`/api/refunds/${refund.id}/retry`).send({}).expect(200)).body.data;
    expect(retried).toMatchObject({ id: refund.id, refundNumber: refund.refundNumber, status: "PROCESSED" });
    expect((await prisma.returnRequest.findUniqueOrThrow({ where: { id: rr.id } })).status).toBe("REFUNDED");
    expect((await payment(order.id)).amountRefunded).toBe(value);

    // Nothing left: neither a new return refund nor a second retry can pay again.
    const again = await admin.post(`/api/returns/${rr.id}/refund`).set("Idempotency-Key", key()).send({}).expect(409);
    expect(again.body.message).toMatch(/already been refunded/);
    await admin.post(`/api/refunds/${refund.id}/retry`).send({}).expect(409);
    expect(await prisma.refund.count({ where: { returnRequestId: rr.id } })).toBe(1);
    expect((await admin.get(`/api/returns/${rr.id}`).expect(200)).body.data.refundableAmount).toBe(0);
  });

  it("a new refund after a failed one is allowed, but the failed one can then no longer be retried", async () => {
    const { order } = await paidOrder(2);
    const { admin, rr } = await receivedReturn(order.id, order.items[0].id, 1);
    await MockPaymentGateway.simulateNextRefundFailure("reject");
    await admin.post(`/api/returns/${rr.id}/refund`).set("Idempotency-Key", key()).send({}).expect(502);
    const failed = await prisma.refund.findFirstOrThrow({ where: { returnRequestId: rr.id, status: "FAILED" } });

    await admin.post(`/api/returns/${rr.id}/refund`).set("Idempotency-Key", key()).send({}).expect(200);
    const retry = await admin.post(`/api/refunds/${failed.id}/retry`).send({}).expect(409);
    expect(retry.body.message).toMatch(/refunded by another refund/);
    const paid = await prisma.refund.aggregate({ where: { returnRequestId: rr.id, status: "PROCESSED" }, _sum: { amount: true } });
    expect(paid._sum.amount).toBe(Math.round(order.items[0].lineTotal / 2));
  });
});

describe("gateway refund edge cases", () => {
  it("records a refund that reached the gateway even when the response was lost", async () => {
    const { order } = await paidOrder(1);
    const { client: admin } = await loginAs(["ADMIN"]);
    await MockPaymentGateway.simulateNextRefundFailure("lost-response");
    const res = await admin.post("/api/refunds").set("Idempotency-Key", key()).send({ orderId: order.id, amount: 30000, reason: "Goodwill" }).expect(201);
    expect(res.body.data).toMatchObject({ status: "PROCESSED", amount: 30000 });
    expect(res.body.data.razorpayRefundId).toMatch(/^rfnd_mock/);
    expect((await payment(order.id)).amountRefunded).toBe(30000);
  });

  it("concurrent refunds can never exceed what was paid", async () => {
    const { order } = await paidOrder(1, 100000);
    const { client: admin } = await loginAs(["ADMIN"]);
    const total = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).grandTotal;
    const share = Math.ceil(total * 0.6);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => admin.post("/api/refunds").set("Idempotency-Key", key()).send({ orderId: order.id, amount: share, reason: "Duplicate click" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await payment(order.id)).amountRefunded).toBe(share);
  });

  it("cancelling a paid order stands even if the refund fails, and the refund can be retried", async () => {
    const { order } = await paidOrder(1);
    const { client: admin } = await loginAs(["ADMIN"]);
    await MockPaymentGateway.simulateNextRefundFailure("reject");
    const res = (await admin.post(`/api/orders/${order.id}/cancel`).send({ reason: "Customer request" }).expect(200)).body.data;
    expect(res.status).toBe("CANCELLED");
    expect(res.refundError).toMatch(/rejected/);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe("FAILED");

    await admin.post(`/api/refunds/${refund.id}/retry`).send({}).expect(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "REFUNDED", paymentStatus: "REFUNDED" });
  });
});
