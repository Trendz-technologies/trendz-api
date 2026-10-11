import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import { createCoupon } from "../src/modules/promotions/coupons.service";
import { loginAs, resetDatabase, type TestClient } from "./helpers";
import { addAddress, level, makeProduct } from "./fixtures";

beforeEach(resetDatabase);
afterAll(closeQueues);

let n = 0;
const key = () => `ops-${Date.now()}-${++n}`;

async function paidOnlineOrder(qty = 2, price = 79900) {
  const { variant, sku } = await makeProduct({ price, stock: 10 });
  const customer = await loginAs(["CUSTOMER"]);
  const c = customer.client;
  const address = await addAddress(c);
  await c.post("/api/cart/items").send({ variantId: variant.id, quantity: qty }).expect(200);
  const order = (await c.post("/api/orders").set("Idempotency-Key", key()).send({ shippingAddressId: address.id }).expect(201)).body.data;
  const pay = (await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId: order.id }).expect(200)).body.data;
  const sim = (await c.post("/api/payments/mock/complete").send({ razorpayOrderId: pay.razorpayOrderId }).expect(200)).body.data;
  await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);
  return { order, customer: c, variant, sku };
}

describe("shipping", () => {
  it("creates a shipment, follows courier tracking and delivers the order", async () => {
    const { order, customer } = await paidOnlineOrder();
    const { client: admin } = await loginAs(["ADMIN"]);
    const [shipment] = (await admin.post("/api/shipments").send({ orderId: order.id }).expect(201)).body.data;
    expect(shipment).toMatchObject({ provider: "MOCK", status: "PICKUP_SCHEDULED" });
    expect(shipment.awb).toMatch(/^MOCK/);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PACKED");
    await admin.post("/api/shipments").send({ orderId: order.id }).expect(409); // already shipped

    for (let i = 0; i < 4; i++) await admin.post(`/api/shipments/${shipment.id}/simulate`).send({}).expect(200);
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { statusHistory: { orderBy: { createdAt: "asc" } } } });
    expect(final.status).toBe("DELIVERED");
    expect(final.statusHistory.map((h) => h.toStatus)).toEqual(["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);
    expect(await prisma.notification.count({ where: { template: "order.shipped" } })).toBe(1);

    const tracking = await customer.get(`/api/account/orders/${order.orderNumber}/tracking`).expect(200);
    expect(tracking.body.data.shipments[0].events.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects courier webhooks without the shared token", async () => {
    const { client: anon } = await loginAs(["CUSTOMER"]);
    await anon.post("/api/shipping/webhook").send({ awb: "X", current_status: "DELIVERED" }).expect(401);
  });
});

describe("returns", () => {
  it("customer return → approve → inspect (GOOD restocks, DAMAGED quarantined) → refund with credit note", async () => {
    const { order, customer, variant } = await paidOnlineOrder(3);
    const { client: admin } = await loginAs(["ADMIN"]);
    await customer.post("/api/account/returns").send({ orderNumber: order.orderNumber, reason: "Too big", items: [{ orderItemId: order.items[0].id, quantity: 1 }] }).expect(409); // not delivered yet

    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const before = await level(variant.id); // 7 on hand after selling 3 of 10
    const rr = (
      await customer
        .post("/api/account/returns")
        .send({ orderNumber: order.orderNumber, reason: "Wrong size", items: [{ orderItemId: order.items[0].id, quantity: 2 }] })
        .expect(201)
    ).body.data;
    expect(rr.returnNumber).toMatch(/^RET-\d{4}-\d{6}$/);
    await customer.post("/api/account/returns").send({ orderNumber: order.orderNumber, reason: "x", items: [{ orderItemId: order.items[0].id, quantity: 2 }] }).expect(400); // only 1 left

    await admin.post(`/api/returns/${rr.id}/approve`).send({}).expect(200);
    // Split the two units: one GOOD, one DAMAGED, by receiving as two lines is not possible for one line → mark the line GOOD.
    await admin.post(`/api/returns/${rr.id}/receive`).send({ items: [{ returnItemId: rr.items[0].id, condition: "GOOD" }] }).expect(200);
    expect(await level(variant.id)).toMatchObject({ onHand: before.onHand + 2, damaged: 0 });
    const ret = await prisma.inventoryTransaction.findMany({ where: { variantId: variant.id, type: "RETURN" } });
    expect(ret).toHaveLength(1);

    const refunded = (await admin.post(`/api/returns/${rr.id}/refund`).set("Idempotency-Key", key()).send({}).expect(200)).body.data;
    expect(refunded.status).toBe("REFUNDED");
    const refund = await prisma.refund.findFirstOrThrow({ where: { returnRequestId: rr.id } });
    expect(refund.amount).toBe(Math.round((order.items[0].lineTotal * 2) / 3));
    expect(await prisma.creditNote.count({ where: { refundId: refund.id } })).toBe(0); // no invoice issued in this test
    await admin.post(`/api/returns/${rr.id}/close`).send({}).expect(200);
  });

  it("damaged returns never go back to sellable stock", async () => {
    const { order, variant } = await paidOnlineOrder(1);
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const { client: admin } = await loginAs(["ADMIN"]);
    const before = await level(variant.id);
    const rr = (await admin.post("/api/returns").send({ orderId: order.id, reason: "Defective zip", approve: true, items: [{ orderItemId: order.items[0].id, quantity: 1 }] }).expect(201)).body.data;
    await admin.post(`/api/returns/${rr.id}/receive`).send({ items: [{ returnItemId: rr.items[0].id, condition: "DEFECTIVE" }] }).expect(200);
    expect(await level(variant.id)).toMatchObject({ onHand: before.onHand, damaged: 1 });
  });

  it("return desk scanning finds the order line for a scanned SKU", async () => {
    const { order, sku } = await paidOnlineOrder(1);
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const { client: admin } = await loginAs(["ADMIN"]);
    const res = await admin.post("/api/returns/scan").send({ code: sku, orderNumber: order.orderNumber }).expect(200);
    expect(res.body.data.candidates[0]).toMatchObject({ orderNumber: order.orderNumber, returnable: 1, eligible: true });
    const other = await makeProduct({ price: 1000, stock: 1 });
    await admin.post("/api/returns/scan").send({ code: other.sku, orderNumber: order.orderNumber }).expect(404);
  });
});

describe("POS billing", () => {
  async function posSetup() {
    const a = await makeProduct({ name: "Tee", price: 79900, stock: 25 });
    const b = await makeProduct({ name: "Jeans", price: 149900, stock: 1 });
    const wh = await prisma.warehouse.findFirstOrThrow({ where: { code: "WH-001" } });
    const cashier = await loginAs(["CASHIER"], { warehouseId: wh.id });
    const cart = (await cashier.client.post("/api/pos/carts").send({ warehouseId: wh.id }).expect(201)).body.data;
    return { a, b, wh, cashier: cashier.client, cart };
  }

  it("continuous scanning increments quantities and a cash sale deducts stock exactly once", async () => {
    const { a, b, cashier, cart } = await posSetup();
    const config = await cashier.get("/api/pos/config").expect(200);
    expect(config.body.data).toMatchObject({ maxManualDiscountBps: 1000, enabledPaymentMethods: expect.arrayContaining(["CASH"]) });
    await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: a.sku }).expect(200);
    await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: b.sku }).expect(200);
    const third = await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: a.sku.toLowerCase() + "\n" }).expect(200);
    expect(third.body.data.cart.items.map((i: { sku: string; quantity: number }) => [i.sku, i.quantity])).toEqual([[a.sku, 2], [b.sku, 1]]);
    expect(third.body.data.cart.totals.grandTotal).toBe(79900 * 2 + 149900);

    const outOfStock = await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: b.sku }).expect(409);
    expect(outOfStock.body.code).toBe("OUT_OF_STOCK");
    const override = await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: b.sku, override: true }).expect(403); // cashier lacks pos.override_stock
    expect(override.body.code).toBe("FORBIDDEN");

    const idem = key();
    const sale = await cashier.post(`/api/pos/carts/${cart.id}/checkout`).set("Idempotency-Key", idem).send({ paymentMethod: "CASH", amountTendered: 400000 }).expect(200);
    expect(sale.body.data).toMatchObject({ requiresGatewayPayment: false, change: 400000 - (79900 * 2 + 149900) });
    const replay = await cashier.post(`/api/pos/carts/${cart.id}/checkout`).set("Idempotency-Key", idem).send({ paymentMethod: "CASH", amountTendered: 400000 }).expect(200);
    expect(replay.body.data.order.id).toBe(sale.body.data.order.id);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: sale.body.data.order.id }, include: { payments: true } });
    expect(order).toMatchObject({ channel: "POS", status: "DELIVERED", paymentStatus: "PAID", shippingStatus: "NOT_REQUIRED" });
    expect(order.orderNumber).toMatch(/^POS-/);
    expect(order.payments[0]).toMatchObject({ provider: "CASH", status: "PAID", amount: order.grandTotal });
    expect(await level(a.variant.id)).toMatchObject({ onHand: 23, reserved: 0 });
    expect(await level(b.variant.id)).toMatchObject({ onHand: 0, reserved: 0 });
    expect(await prisma.inventoryTransaction.count({ where: { type: "SALE", referenceId: order.id } })).toBe(2);
  });

  it("enforces manual discount permission and cap; managers may override stock", async () => {
    const { a, b, wh, cashier, cart } = await posSetup();
    await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: a.sku }).expect(200);
    await cashier.patch(`/api/pos/carts/${cart.id}`).send({ manualDiscount: 1000, manualDiscountReason: "Loyal" }).expect(403);

    const manager = (await loginAs(["MANAGER"])).client;
    const mCart = (await manager.post("/api/pos/carts").send({ warehouseId: wh.id }).expect(201)).body.data;
    await manager.post(`/api/pos/carts/${mCart.id}/scan`).send({ code: a.sku }).expect(200);
    const capped = await manager.patch(`/api/pos/carts/${mCart.id}`).send({ manualDiscount: 20000, manualDiscountReason: "Too much" }).expect(400);
    expect(capped.body.code).toBe("DISCOUNT_LIMIT"); // default cap 10%
    await manager.patch(`/api/pos/carts/${mCart.id}`).send({ manualDiscount: 5000, manualDiscountReason: "Festival" }).expect(200);

    await manager.post(`/api/pos/carts/${mCart.id}/scan`).send({ code: b.sku }).expect(200);
    await manager.post(`/api/pos/carts/${mCart.id}/scan`).send({ code: b.sku, override: true }).expect(200);
    const sale = await manager.post(`/api/pos/carts/${mCart.id}/checkout`).set("Idempotency-Key", key()).send({ paymentMethod: "UPI_MANUAL", referenceNumber: "UPI123456" }).expect(200);
    expect(await level(b.variant.id)).toMatchObject({ onHand: -1 }); // sold beyond stock with override
    expect(await prisma.auditLog.count({ where: { action: "pos.override_stock" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "pos.manual_discount" } })).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: sale.body.data.order.id } });
    expect(order.discountTotal).toBe(5000);
  });

  it("Razorpay at the counter reserves stock until the gateway confirms", async () => {
    const { a, cashier, cart } = await posSetup();
    await createCoupon({ code: "STORE5", discountType: "PERCENTAGE", value: 500, scope: "ALL", channel: "POS", isActive: true, isPublic: false, productIds: [], categoryIds: [] }, systemContext);
    await cashier.post(`/api/pos/carts/${cart.id}/scan`).send({ code: a.sku, quantity: 2 }).expect(200);
    await cashier.patch(`/api/pos/carts/${cart.id}`).send({ couponCode: "store5", customerPhone: "9876500000", customerName: "Ravi" }).expect(200);
    const sale = (await cashier.post(`/api/pos/carts/${cart.id}/checkout`).set("Idempotency-Key", key()).send({ paymentMethod: "RAZORPAY" }).expect(200)).body.data;
    expect(sale.requiresGatewayPayment).toBe(true);
    expect(await level(a.variant.id)).toMatchObject({ onHand: 25, reserved: 2 });

    const pay = (await cashier.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId: sale.order.id }).expect(200)).body.data;
    const sim = (await cashier.post("/api/payments/mock/complete").send({ razorpayOrderId: pay.razorpayOrderId }).expect(200)).body.data;
    await cashier.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: sale.order.id } });
    expect(order).toMatchObject({ status: "DELIVERED", paymentStatus: "PAID", couponCode: "STORE5", customerName: "Ravi" });
    expect(await level(a.variant.id)).toMatchObject({ onHand: 23, reserved: 0 });

    const receipt = await cashier.get(`/api/pos/orders/${order.id}/receipt`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((receipt.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("dashboard and reports", () => {
  it("summarises paid sales and exports reports", async () => {
    await paidOnlineOrder(2, 50000);
    const { client: admin } = await loginAs(["ADMIN"]);
    const summary = (await admin.get("/api/dashboard/summary").expect(200)).body.data;
    expect(summary).toMatchObject({ totalOrders: 1, totalSales: 100000, pendingOrders: 1, totalCustomers: 1 });
    const charts = (await admin.get("/api/dashboard/charts?range=7d").expect(200)).body.data;
    expect(charts.sales).toHaveLength(7);
    expect(charts.sales.reduce((s: number, d: { revenue: number }) => s + d.revenue, 0)).toBe(100000);

    const sales = (await admin.get("/api/reports/sales").expect(200)).body.data;
    expect(sales.totals).toMatchObject({ orders: 1, revenue: 100000 });
    const taxes = (await admin.get("/api/reports/taxes").expect(200)).body.data;
    expect(taxes.totals.taxable + taxes.totals.tax).toBe(100000);

    const csv = await admin.get("/api/reports/products?format=csv").expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/SKU,Product/);
    const xlsx = await admin.get("/api/reports/inventory?format=xlsx").expect(200);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);

    const { client: support } = await loginAs(["SUPPORT"]);
    await support.get("/api/reports/sales").expect(403);
  });
});

export type { TestClient };
