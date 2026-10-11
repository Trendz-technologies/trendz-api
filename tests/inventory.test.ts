import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, withTransaction } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { applyMovements } from "../src/modules/inventory/stock";
import { loginAs, resetDatabase, type TestClient } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

async function catalog(admin: TestClient) {
  const cat = (await admin.post("/api/categories").send({ name: "Tees" }).expect(201)).body.data;
  const product = (
    await admin
      .post("/api/products")
      .send({
        name: "Tee",
        baseSku: "TEE",
        categoryId: cat.id,
        status: "ACTIVE",
        options: [{ name: "Size", values: ["M", "L"] }],
        variants: [
          { sku: "TEE-M", options: { Size: "M" }, mrp: 99900, sellingPrice: 79900, costPrice: 30000 },
          { sku: "TEE-L", options: { Size: "L" }, mrp: 99900, sellingPrice: 79900 },
        ],
      })
      .expect(201)
  ).body.data;
  const wh = await prisma.warehouse.findFirstOrThrow();
  return { m: product.variants[0] as { id: string }, l: product.variants[1] as { id: string }, wh };
}

const level = (variantId: string, warehouseId: string) =>
  prisma.inventoryLevel.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId, warehouseId } } });

describe("stock adjustments and the ledger", () => {
  it("records every change with before/after balances and an audit entry", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);

    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, mode: "set", quantity: 25 }] }).expect(201);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "DAMAGE", items: [{ variantId: m.id, quantity: 2 }] }).expect(201);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "COUNT_CORRECTION", items: [{ variantId: m.id, mode: "set", quantity: 20 }] }).expect(201);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "FOUND", items: [{ variantId: m.id, mode: "set", quantity: 30 }] }).expect(400); // absolute counts only for corrections / opening stock

    expect(await level(m.id, wh.id)).toMatchObject({ onHand: 20, damaged: 2, reserved: 0 });
    const ledger = await prisma.inventoryTransaction.findMany({ where: { variantId: m.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.type, l.bucket, l.quantity, l.balanceBefore, l.balanceAfter])).toEqual([
      ["ADJUSTMENT", "ON_HAND", 25, 0, 25],
      ["DAMAGE", "ON_HAND", -2, 25, 23],
      ["DAMAGE", "DAMAGED", 2, 0, 2],
      ["STOCK_CORRECTION", "ON_HAND", -3, 23, 20],
    ]);
    expect(ledger.every((l) => l.referenceType === "ADJUSTMENT" && l.referenceNumber?.startsWith("ADJ-"))).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "inventory.adjust" } })).toBe(3);

    const listed = await admin.get(`/api/inventory?warehouseId=${wh.id}&q=TEE-M`).expect(200);
    expect(listed.body.data[0]).toMatchObject({ sku: "TEE-M", onHand: 20, available: 20, damaged: 2, stockValue: 20 * 30000 });
  });

  it("never lets an adjustment eat into reserved stock", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, quantity: 5 }] }).expect(201);
    await withTransaction((tx) => applyMovements(tx, [{ variantId: m.id, warehouseId: wh.id, bucket: "RESERVED", delta: 3, type: "RESERVATION" }], {}));

    const res = await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "LOSS", items: [{ variantId: m.id, quantity: -3 }] }).expect(409);
    expect(res.body.code).toBe("OUT_OF_STOCK");
    expect(await level(m.id, wh.id)).toMatchObject({ onHand: 5, reserved: 3 });
  });

  it("the ledger is append-only at the database level", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "FOUND", items: [{ variantId: m.id, quantity: 1 }] }).expect(201);
    await expect(prisma.$executeRaw`UPDATE inventory_transactions SET quantity = 100`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM inventory_transactions`).rejects.toThrow(/append-only/);
  });

  it("only staff with inventory.adjust can change stock", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "FOUND", items: [{ variantId: m.id, quantity: 1 }] }).expect(403);
  });
});

describe("concurrency", () => {
  it("never oversells the last unit under concurrent reservations", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, quantity: 1 }] }).expect(201);

    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        withTransaction((tx) => applyMovements(tx, [{ variantId: m.id, warehouseId: wh.id, bucket: "RESERVED", delta: 1, type: "RESERVATION" }], {})),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected").every((a) => (a as PromiseRejectedResult).reason.code === "OUT_OF_STOCK")).toBe(true);
    expect(await level(m.id, wh.id)).toMatchObject({ onHand: 1, reserved: 1 });
  });

  it("serialises many concurrent buyers exactly up to the stock level", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, l, wh } = await catalog(admin);
    await admin
      .post("/api/inventory/adjust")
      .send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, quantity: 15 }, { variantId: l.id, quantity: 15 }] })
      .expect(201);

    // 25 checkouts, each taking one M and one L, locking rows in opposite orders.
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        withTransaction((tx) =>
          applyMovements(
            tx,
            (i % 2 ? [m, l] : [l, m]).map((v) => ({ variantId: v.id, warehouseId: wh.id, bucket: "RESERVED" as const, delta: 1, type: "RESERVATION" as const })),
            {},
          ),
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(15);
    expect(await level(m.id, wh.id)).toMatchObject({ onHand: 15, reserved: 15 });
    expect(await level(l.id, wh.id)).toMatchObject({ onHand: 15, reserved: 15 });
    expect(await prisma.inventoryTransaction.count({ where: { type: "RESERVATION" } })).toBe(30);
  });
});

describe("transfers", () => {
  it("moves stock between warehouses through dispatch and receive", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    const store = (
      await admin
        .post("/api/warehouses")
        .send({ code: "WH-002", name: "City Store", addressLine1: "1 Main Rd", city: "Chennai", state: "Tamil Nadu", postalCode: "600002" })
        .expect(201)
    ).body.data;
    expect(store.stateCode).toBe("33");
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, quantity: 10 }] }).expect(201);

    const tooMany = (await admin.post("/api/inventory/transfers").send({ fromWarehouseId: wh.id, toWarehouseId: store.id, items: [{ variantId: m.id, quantity: 11 }] }).expect(201)).body.data;
    await admin.post(`/api/inventory/transfers/${tooMany.id}/dispatch`).send({}).expect(409);

    const t = (await admin.post("/api/inventory/transfer").send({ fromWarehouseId: wh.id, toWarehouseId: store.id, items: [{ variantId: m.id, quantity: 6 }] }).expect(201)).body.data;
    expect(t.number).toMatch(/^TRF-\d{4}-\d{4}$/);
    await admin.post(`/api/inventory/transfers/${t.id}/dispatch`).send({}).expect(200);
    await admin.post(`/api/inventory/transfers/${t.id}/dispatch`).send({}).expect(409); // not twice
    expect((await level(m.id, wh.id)).onHand).toBe(4);

    const received = await admin.post(`/api/inventory/transfers/${t.id}/receive`).send({ items: [{ variantId: m.id, receivedQuantity: 5 }] }).expect(200);
    expect(received.body.data.status).toBe("RECEIVED");
    expect((await level(m.id, store.id)).onHand).toBe(5);
    expect(received.body.data.notes).toMatch(/Shortfall/);
  });

  it("cancelling an in-transit transfer returns stock to the source", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, wh } = await catalog(admin);
    const store = await prisma.warehouse.create({ data: { code: "WH-009", name: "B", addressLine1: "x", city: "Chennai", state: "Tamil Nadu", stateCode: "33", postalCode: "600002" } });
    await admin.post("/api/inventory/adjust").send({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: m.id, quantity: 3 }] }).expect(201);
    const t = (await admin.post("/api/inventory/transfers").send({ fromWarehouseId: wh.id, toWarehouseId: store.id, items: [{ variantId: m.id, quantity: 3 }] }).expect(201)).body.data;
    await admin.post(`/api/inventory/transfers/${t.id}/dispatch`).send({}).expect(200);
    await admin.post(`/api/inventory/transfers/${t.id}/cancel`).send({}).expect(200);
    expect((await level(m.id, wh.id)).onHand).toBe(3);
  });
});

describe("purchase orders", () => {
  it("runs the full workflow and creates PURCHASE ledger entries on receipt", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, l, wh } = await catalog(admin);
    const supplier = (await admin.post("/api/suppliers").send({ code: "SUP-1", name: "Tiruppur Knits", gstin: "33ABCDE1234F1Z5", state: "Tamil Nadu" }).expect(201)).body.data;

    const po = (
      await admin
        .post("/api/purchase-orders")
        .send({
          supplierId: supplier.id,
          warehouseId: wh.id,
          shippingCost: 50000,
          items: [
            { variantId: m.id, quantity: 10, unitCost: 25000, taxRateBps: 500 },
            { variantId: l.id, quantity: 5, unitCost: 25000, taxRateBps: 500 },
          ],
        })
        .expect(201)
    ).body.data;
    expect(po).toMatchObject({ status: "DRAFT", subtotal: 375000, taxTotal: 18750, grandTotal: 375000 + 18750 + 50000 });

    const receiveBody = (qtyM: number, damagedM: number) => ({
      items: [{ purchaseOrderItemId: po.items.find((i: { variantId: string }) => i.variantId === m.id).id, quantityReceived: qtyM, quantityDamaged: damagedM }],
    });
    await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-try-0001").send(receiveBody(1, 0)).expect(409); // not approved

    await admin.post(`/api/purchase-orders/${po.id}/submit`).send({}).expect(200);
    const { client: inventoryManager } = await loginAs(["INVENTORY_MANAGER"]);
    await inventoryManager.post(`/api/purchase-orders/${po.id}/approve`).send({}).expect(403); // needs purchases.approve
    await admin.post(`/api/purchase-orders/${po.id}/approve`).send({}).expect(200);

    // A double-submitted form with the same key adds stock only once.
    const first = await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-0000-0001").send(receiveBody(7, 1)).expect(200);
    const replay = await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-0000-0001").send(receiveBody(7, 1)).expect(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(first.body.data.status).toBe("PARTIALLY_RECEIVED");
    expect(await level(m.id, wh.id)).toMatchObject({ onHand: 7, damaged: 1 });

    const over = await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-0000-0002").send(receiveBody(3, 0)).expect(400);
    expect(over.body.message).toMatch(/only 2 pending/);

    await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-0000-0003").send(receiveBody(2, 0)).expect(200);
    const lineL = po.items.find((i: { variantId: string }) => i.variantId === l.id).id;
    const done = await admin.post(`/api/purchase-orders/${po.id}/receive`).set("Idempotency-Key", "grn-0000-0004").send({ items: [{ purchaseOrderItemId: lineL, quantityReceived: 5 }] }).expect(200);
    expect(done.body.data.status).toBe("RECEIVED");
    await admin.post(`/api/purchase-orders/${po.id}/close`).send({}).expect(200);

    const purchases = await prisma.inventoryTransaction.findMany({ where: { type: "PURCHASE" } });
    expect(purchases.reduce((s, p) => s + p.quantity, 0)).toBe(15);
    expect(purchases.every((p) => p.referenceType === "GOODS_RECEIPT")).toBe(true);

    const history = await admin.get(`/api/suppliers/${supplier.id}/purchase-history`).expect(200);
    expect(history.body.data[0]).toMatchObject({ quantityOrdered: 15, quantityReceived: 15, quantityPending: 0 });
  });
});
