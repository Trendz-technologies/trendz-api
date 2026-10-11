import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { buildEan13, gs1CheckDigit, isValidEan13, isValidUpcA, parseScannedInput } from "../src/modules/codes/barcode-utils";
import { loginAs, resetDatabase, type TestClient } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

describe("barcode maths", () => {
  it("computes GS1 check digits", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidUpcA("036000291452")).toBe(true);
    expect(gs1CheckDigit("890123456789")).toBe(0); // -> 8901234567890 (the spec example)
    expect(isValidEan13(buildEan13("200", 42))).toBe(true);
    expect(buildEan13("200", 42).startsWith("200000000042")).toBe(true);
  });

  it("parses scanner input in every supported form", () => {
    expect(parseScannedInput('{"type":"PRODUCT","sku":"tsh-1","id":"QABC"}\r\n')).toEqual({ codeValue: "QABC", sku: "TSH-1" });
    expect(parseScannedInput("  8901234567890\n")).toEqual({ codeValue: "8901234567890", sku: "8901234567890" });
    expect(parseScannedInput("tsh-red-m-001")).toEqual({ codeValue: "tsh-red-m-001", sku: "TSH-RED-M-001" });
  });
});

async function setup(admin: TestClient) {
  const cat = (await admin.post("/api/categories").send({ name: "Tees" }).expect(201)).body.data;
  const product = (
    await admin
      .post("/api/products")
      .send({
        name: "Cotton Kurti",
        baseSku: "TSH",
        categoryId: cat.id,
        status: "ACTIVE",
        options: [{ name: "Size", values: ["M", "L"] }],
        variants: [
          { sku: "TSH-RED-M-001", options: { Size: "M" }, mrp: 99900, sellingPrice: 79900 },
          { sku: "TSH-RED-L-001", options: { Size: "L" }, mrp: 99900, sellingPrice: 79900 },
        ],
      })
      .expect(201)
  ).body.data;
  const whA = await prisma.warehouse.findFirstOrThrow();
  const whB = await prisma.warehouse.create({
    data: { code: "WH-002", name: "Store B", addressLine1: "x", city: "Chennai", state: "Tamil Nadu", stateCode: "33", postalCode: "600002" },
  });
  return { product, m: product.variants[0], l: product.variants[1], whA, whB };
}

describe("product codes", () => {
  it("generates, assigns and protects code uniqueness", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, l } = await setup(admin);

    const qr = (await admin.post(`/api/variants/${m.id}/codes`).send({ type: "QR" }).expect(201)).body.data;
    expect(qr.codeValue).toMatch(/^Q[2-9A-HJ-NP-Z]{10}$/);
    expect(JSON.parse(qr.qrPayload)).toEqual({ type: "PRODUCT", sku: "TSH-RED-M-001", id: qr.codeValue });

    const ean = (await admin.post(`/api/variants/${m.id}/codes`).send({ type: "EAN13" }).expect(201)).body.data;
    expect(isValidEan13(ean.codeValue)).toBe(true);
    expect(ean.codeValue.startsWith("200")).toBe(true);

    await admin.post(`/api/variants/${l.id}/codes`).send({ type: "EAN13", value: "8901234567891" }).expect(400); // bad check digit
    await admin.post(`/api/variants/${l.id}/codes`).send({ type: "EAN13", value: "8901234567890" }).expect(201);
    const dup = await admin.post(`/api/variants/${m.id}/codes`).send({ type: "EAN13", value: "8901234567890" }).expect(409);
    expect(dup.body.code).toBe("DUPLICATE_CODE");
    // A barcode that equals another variant's SKU would be ambiguous at the till.
    const clash = await admin.post(`/api/variants/${m.id}/codes`).send({ type: "CODE128", value: "TSH-RED-L-001" }).expect(409);
    expect(clash.body.code).toBe("DUPLICATE_CODE");

    const regenerated = (await admin.post(`/api/codes/${qr.id}/regenerate`).send({}).expect(201)).body.data;
    expect(regenerated.codeValue).not.toBe(qr.codeValue);
    expect((await prisma.productCode.findUniqueOrThrow({ where: { id: qr.id } })).status).toBe("INACTIVE");
    expect(await prisma.auditLog.count({ where: { entityType: "product_code" } })).toBeGreaterThanOrEqual(5);

    const png = await admin.get(`/api/codes/${ean.id}/image?format=png`).expect(200);
    expect(png.headers["content-type"]).toBe("image/png");
    const svg = await admin.get(`/api/codes/${regenerated.id}/image?format=svg`).expect(200);
    expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
  });

  it("bulk-generates only missing codes and prints label sheets", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { product, m } = await setup(admin);
    await admin.post(`/api/variants/${m.id}/codes`).send({ type: "QR" }).expect(201);

    const bulk = await admin.post("/api/codes/bulk-generate").send({ productIds: [product.id], types: ["QR", "EAN13"] }).expect(200);
    expect(bulk.body.data).toEqual({ variants: 2, created: 3, skipped: 1 });

    const pdf = await admin
      .post("/api/codes/labels")
      .send({ items: [{ variantId: m.id, copies: 30 }], layout: "A4_3x8", barcodeType: "EAN13" })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("cashiers can scan but cannot manage codes", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, whA } = await setup(admin);
    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.post(`/api/variants/${m.id}/codes`).send({ type: "QR" }).expect(403);
    await cashier.post("/api/products/scan").send({ code: "TSH-RED-M-001", warehouseId: whA.id }).expect(200);
  });
});

describe("scanning", () => {
  it("resolves QR payloads, barcodes and SKUs to one variant with warehouse stock", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { m, l, whA, whB } = await setup(admin);
    const qr = (await admin.post(`/api/variants/${m.id}/codes`).send({ type: "QR" }).expect(201)).body.data;
    await admin.post(`/api/variants/${m.id}/codes`).send({ type: "EAN13", value: "8901234567890" }).expect(201);
    await prisma.inventoryLevel.createMany({
      data: [
        { variantId: m.id, warehouseId: whA.id, onHand: 25 },
        { variantId: l.id, warehouseId: whB.id, onHand: 10 },
      ],
    });

    const byQr = await admin.post("/api/products/scan").send({ code: qr.qrPayload + "\r\n", warehouseId: whA.id }).expect(200);
    expect(byQr.body.data.product).toMatchObject({
      sku: "TSH-RED-M-001",
      variant: "M",
      barcode: "8901234567890",
      price: 79900,
      availableStock: 25,
      stockStatus: "IN_STOCK",
      matchedBy: "CODE",
    });
    expect(byQr.body.data.product.costPrice).toBeUndefined();

    const byEan = await admin.get(`/api/products/code/8901234567890?warehouseId=${whA.id}`).expect(200);
    expect(byEan.body.data.product.variantId).toBe(m.id);

    const elsewhere = await admin.post("/api/products/scan").send({ code: "tsh-red-l-001", warehouseId: whA.id }).expect(200);
    expect(elsewhere.body.data.product).toMatchObject({ stockStatus: "OTHER_WAREHOUSE", message: "Product available in another warehouse.", availableStock: 0 });

    const out = await admin.post("/api/products/scan").send({ code: "TSH-RED-L-001", warehouseId: whB.id }).expect(200);
    expect(out.body.data.product.stockStatus).toBe("IN_STOCK");

    const unknown = await admin.post("/api/products/scan").send({ code: "NOPE-123", warehouseId: whA.id }).expect(404);
    expect(unknown.body).toMatchObject({ code: "CODE_NOT_FOUND", message: "Product code not found." });

    await admin.patch(`/api/codes/${qr.id}`).send({ status: "INACTIVE" }).expect(200);
    const inactive = await admin.post("/api/products/scan").send({ code: qr.qrPayload, warehouseId: whA.id }).expect(409);
    expect(inactive.body).toMatchObject({ code: "CODE_INACTIVE", message: "This product code is inactive." });

    await prisma.productVariant.update({ where: { id: m.id }, data: { status: "DISCONTINUED" } });
    const disc = await admin.post("/api/products/scan").send({ code: "8901234567890", warehouseId: whA.id }).expect(409);
    expect(disc.body).toMatchObject({ code: "PRODUCT_DISCONTINUED", message: "This product is discontinued." });
  });
});
