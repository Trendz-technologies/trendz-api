import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { storage } from "../src/integrations/object-storage";
import { MAX_IMAGE_BYTES } from "../src/integrations/object-storage";
import * as remote from "../src/modules/media/remote-image";
import { client, loginAs, resetDatabase, type TestClient } from "./helpers";

// The import downloads pictures from the internet; here every address is answered locally.
vi.mock("../src/modules/media/remote-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/media/remote-image")>();
  return { ...actual, downloadImage: vi.fn() };
});

beforeEach(resetDatabase);
afterAll(closeQueues);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const png = (color: string) => sharp({ create: { width: 900, height: 1200, channels: 3, background: color } }).png().toBuffer();

async function serveImages(missing: string[] = []) {
  const picture = await png("#c36");
  vi.mocked(remote.downloadImage).mockImplementation(async (url: string) => {
    if (missing.includes(url)) throw new remote.RemoteImageError("The site answered with status 404");
    return picture;
  });
}

async function setup() {
  const { client: admin } = await loginAs(["ADMIN"]);
  const category = (await admin.post("/api/categories").send({ name: "Kurti Sets" }).expect(201)).body.data as { id: string };
  await admin.post("/api/brands").send({ name: "Trendz Studio" }).expect(201);
  return { admin, category };
}

/** The template from the API, with `rows` written into its Products sheet. */
async function workbook(admin: TestClient, rows: Record<string, string | number>[]) {
  const res = await admin.get("/api/products/import/template").buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => cb(null, Buffer.concat(chunks)));
  }).expect(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as ExcelJS.Buffer);
  const ws = wb.getWorksheet("Products")!;
  const headings = (ws.getRow(1).values as (string | undefined)[]).slice(1);
  for (const r of rows) ws.addRow(headings.map((h) => r[h!] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const kurti = { "Base SKU *": "KUR-1001", "Product name *": "Floral Cotton Kurti", "Category *": "Kurti Sets", Brand: "Trendz Studio", Status: "Active", Tags: "cotton, floral", "HSN code": "6204", Description: "Soft cotton.\n\nMachine wash cold." };
const prices = { "MRP (₹) *": 1299, "Selling price (₹) *": 999, "Cost price (₹)": 550, "Weight (g)": 250 };

describe("product import", () => {
  it("offers a template with the shop's categories and brands", async () => {
    const { admin } = await setup();
    const res = await admin.get("/api/products/import/template").expect(200);
    expect(res.headers["content-type"]).toBe(XLSX);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await workbook(admin, [])) as unknown as ExcelJS.Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Products", "Lists", "Example", "How to fill"]);
    expect(wb.getWorksheet("Products")!.getCell("A1").value).toBe("Base SKU *");
    expect(wb.getWorksheet("Lists")!.getCell("A2").value).toBe("Kurti Sets");
    expect(wb.getWorksheet("Lists")!.getCell("B2").value).toBe("Trendz Studio");
  });

  it("previews a sheet: groups rows into products, skips products already in the shop and reports problems by row", async () => {
    const { admin, category } = await setup();
    await admin.post("/api/products").send({
      name: "Old Kurti", baseSku: "OLD-100", categoryId: category.id, options: [], variants: [{ sku: "OLD-100", mrp: 50000, sellingPrice: 40000 }],
    }).expect(201);

    const file = await workbook(admin, [
      { ...kurti, Size: "S", Color: "Pink", ...prices, "Product image URLs": "https://img.test/kurti-front.jpg, https://img.test/kurti-back.jpg", "Variant image URLs": "https://img.test/pink.jpg" },
      { "Base SKU *": "KUR-1001", Size: "M", Color: "pink", ...prices },
      { "Base SKU *": "KUR-1001", Size: "S", Color: "Blue", ...prices, "Variant image URLs": "https://img.test/blue.jpg" },
      { "Base SKU *": "KUR-1001", Size: "M", Color: "Blue", ...prices },
      { "Base SKU *": "KUR-1001", Size: "M", Color: "Blue", ...prices }, // the same row again
      { "Base SKU *": "OLD-100", "Product name *": "Old Kurti", "Category *": "Kurti Sets", ...prices },
      { "Base SKU *": "BAD-1", "Product name *": "Broken", "Category *": "Sarees", "MRP (₹) *": 500, "Selling price (₹) *": 900 },
      { "Base SKU *": "DUP-2001", "Product name *": "Silk Dupatta", "Category *": "kurti-sets", "MRP (₹) *": "₹ 1,099.50", "Selling price (₹) *": 899 },
    ]);
    const res = await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(file).expect(200);
    const preview = res.body.data;

    expect(preview.rows).toBe(8);
    expect(preview.ready.map((p: { baseSku: string }) => p.baseSku)).toEqual(["KUR-1001", "DUP-2001"]);
    const k = preview.ready[0];
    expect(k).toMatchObject({ name: "Floral Cotton Kurti", rows: [2, 3, 4, 5, 6], category: "Kurti Sets", variants: 4, images: 4, options: "Size: S, M · Color: Pink, Blue" });
    expect(k.warnings).toEqual(["Row 6 repeats row 5 (M / Blue) and was left out"]);
    expect(k.payload.product.variants.map((v: { sku: string }) => v.sku)).toEqual(["KUR-1001-S-PINK", "KUR-1001-M-PINK", "KUR-1001-S-BLUE", "KUR-1001-M-BLUE"]);
    expect(k.payload.product.variants[0]).toMatchObject({ mrp: 129900, sellingPrice: 99900, costPrice: 55000, weightGrams: 250, isDefault: true });
    expect(k.payload.product.description).toBe("<p>Soft cotton.</p><p>Machine wash cold.</p>");
    expect(k.payload.images).toEqual([
      { url: "https://img.test/kurti-front.jpg", variantSku: null },
      { url: "https://img.test/kurti-back.jpg", variantSku: null },
      { url: "https://img.test/pink.jpg", variantSku: "KUR-1001-S-PINK" },
      { url: "https://img.test/blue.jpg", variantSku: "KUR-1001-S-BLUE" },
    ]);
    expect(preview.ready[1].payload.product.variants).toEqual([expect.objectContaining({ sku: "DUP-2001", mrp: 109950 })]);

    expect(preview.skipped).toEqual([{ baseSku: "OLD-100", name: "Old Kurti", rows: [7], reason: 'Already in the shop as "Old Kurti"' }]);
    expect(preview.problems).toHaveLength(1);
    expect(preview.problems[0].baseSku).toBe("BAD-1");
    expect(preview.problems[0].errors.join(" | ")).toContain('Category "Sarees" does not exist');
    expect(preview.problems[0].errors.join(" | ")).toContain("Row 8: the selling price is more than the MRP");
  });

  it("reports a sheet without the required columns, and needs products.write", async () => {
    const { admin } = await setup();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Products").addRow(["Name", "Price"]);
    const res = await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(Buffer.from(await wb.xlsx.writeBuffer())).expect(400);
    // "Price" is read as the selling price; the other required columns are missing.
    expect(res.body.message).toContain("no column for Base SKU, Category, MRP (₹).");
    await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(Buffer.from("not a workbook")).expect(400);

    const { client: storeman } = await loginAs(["INVENTORY_MANAGER"]);
    await storeman.post("/api/products/import/preview").set("Content-Type", XLSX).send(Buffer.from("x")).expect(403);
    const anonymous = await client();
    await anonymous.get("/api/products/import/template").expect(401);
  });

  it("adds a ready product with its pictures, tags variant pictures and never adds it twice", async () => {
    const { admin } = await setup();
    await serveImages();
    const file = await workbook(admin, [
      { ...kurti, Size: "S", Color: "Pink", ...prices, "Product image URLs": "https://img.test/front.jpg", "Variant image URLs": "https://img.test/pink.jpg" },
      { "Base SKU *": "KUR-1001", Size: "S", Color: "Blue", ...prices, "Variant image URLs": "https://img.test/blue.jpg" },
    ]);
    const [ready] = (await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(file).expect(200)).body.data.ready;

    const res = await admin.post("/api/products/import/product").send(ready.payload).expect(200);
    expect(res.body.data).toMatchObject({ status: "created", product: { name: "Floral Cotton Kurti", baseSku: "KUR-1001" }, images: { added: 3, failed: [] } });

    const product = await prisma.product.findUniqueOrThrow({
      where: { baseSku: "KUR-1001" },
      include: { variants: true, images: { orderBy: { sortOrder: "asc" } }, brand: true, options: { include: { values: true } } },
    });
    expect(product.status).toBe("ACTIVE");
    expect(product.brand?.name).toBe("Trendz Studio");
    expect(product.tags).toEqual(["cotton", "floral"]);
    expect(product.options.map((o) => o.name)).toEqual(["Size", "Color"]);
    expect(product.images.map((i) => i.status)).toEqual(["READY", "READY", "READY"]);
    const skuOf = (variantId: string | null) => product.variants.find((v) => v.id === variantId)?.sku ?? null;
    expect(product.images.map((i) => skuOf(i.variantId))).toEqual([null, "KUR-1001-S-PINK", "KUR-1001-S-BLUE"]);
    expect(product.images[1]!.altText).toBe("Floral Cotton Kurti – S / Pink");

    // The same product again (the file imported twice): nothing new.
    const again = await admin.post("/api/products/import/product").send(ready.payload).expect(200);
    expect(again.body.data).toEqual({ status: "skipped", reason: 'Already in the shop as "Floral Cotton Kurti"' });
    expect(await prisma.product.count()).toBe(1);
    const second = (await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(file).expect(200)).body.data;
    expect(second.ready).toEqual([]);
    expect(second.skipped.map((s: { baseSku: string }) => s.baseSku)).toEqual(["KUR-1001"]);

    await storage().delete(product.images.flatMap((i) => Object.values((i.sizes ?? {}) as Record<string, { key: string }>).map((s) => s.key)));
  });

  it("does not add a product when one of its pictures cannot be downloaded", async () => {
    const { admin } = await setup();
    await serveImages(["https://img.test/missing.jpg"]);
    const file = await workbook(admin, [
      { "Base SKU *": "DUP-2001", "Product name *": "Silk Dupatta", "Category *": "Kurti Sets", ...prices, "Product image URLs": "https://img.test/ok.jpg\nhttps://img.test/missing.jpg" },
    ]);
    const [ready] = (await admin.post("/api/products/import/preview").set("Content-Type", XLSX).send(file).expect(200)).body.data.ready;
    const res = await admin.post("/api/products/import/product").send(ready.payload).expect(422);
    expect(res.body.message).toContain("Picture 2 (https://img.test/missing.jpg): The site answered with status 404");
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.productImage.count()).toBe(0);
  });
});

describe("pictures from web addresses", () => {
  it("only reaches the public internet", async () => {
    const { downloadImage } = await vi.importActual<typeof import("../src/modules/media/remote-image")>("../src/modules/media/remote-image");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::a00:1"]) {
      expect(remote.isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "104.16.1.1", "2606:4700::1111"]) expect(remote.isPublicAddress(ip), ip).toBe(true);

    for (const url of ["http://127.0.0.1/a.png", "http://2130706433/a.png", "http://[::1]/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://localhost/a.png", "http://10.0.0.8/a.png"]) {
      await expect(downloadImage(url), url).rejects.toThrow("private network");
    }
    await expect(downloadImage("ftp://example.com/a.png")).rejects.toThrow("Only http:// and https://");
    await expect(downloadImage("https://example.com:8443/a.png")).rejects.toThrow("standard web ports");
    await expect(downloadImage("not a url")).rejects.toThrow("not a valid web address");
  });

  it("turns share links into file addresses", () => {
    expect(remote.directImageUrl("https://drive.google.com/file/d/1AbC-dE_f/view?usp=sharing")).toBe("https://drive.google.com/uc?export=download&id=1AbC-dE_f");
    expect(remote.directImageUrl("https://www.dropbox.com/s/xyz/photo.jpg?dl=0")).toBe("https://www.dropbox.com/s/xyz/photo.jpg?dl=1");
    expect(remote.directImageUrl("https://cdn.test/a.jpg")).toBe("https://cdn.test/a.jpg");
  });

  it("keeps small pictures as they are and shrinks or converts the rest", async () => {
    const small = await png("#123456");
    expect(await remote.prepareImage(small)).toEqual({ body: small, contentType: "image/png" });

    const large = await sharp({ create: { width: 2600, height: 2600, channels: 3, background: "#888", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();
    expect(large.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const shrunk = await remote.prepareImage(large);
    expect(shrunk.contentType).toBe("image/webp");
    expect(shrunk.body.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    const width = (await sharp(shrunk.body).metadata()).width;
    expect(width).toBeGreaterThanOrEqual(1600);
    expect(width).toBeLessThanOrEqual(2400);

    const gif = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#f00" } }).gif().toBuffer();
    expect((await remote.prepareImage(gif)).contentType).toBe("image/webp");
    await expect(remote.prepareImage(Buffer.from("<html>not a picture</html>"))).rejects.toThrow("not a picture");
  });
});
