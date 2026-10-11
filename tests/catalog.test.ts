import { afterAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { processImage } from "../src/modules/media/images.service";
import { storage } from "../src/integrations/object-storage";
import { client, latestJob, loginAs, resetDatabase, type TestClient } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

async function makeCategory(c: TestClient, name = "Tops", parentId?: string) {
  const res = await c.post("/api/categories").send({ name, parentId }).expect(201);
  return res.body.data as { id: string; slug: string; path: string; depth: number };
}

function productBody(categoryId: string, overrides: Record<string, unknown> = {}): { variants: unknown[]; [key: string]: unknown } {
  return {
    name: "Relaxed Tee",
    baseSku: "TSH-100",
    categoryId,
    status: "ACTIVE",
    options: [
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["S", "M"] },
    ],
    variants: [
      { sku: "TSH-100-RED-S", options: { Color: "Red", Size: "S" }, mrp: 99900, sellingPrice: 79900 },
      { sku: "TSH-100-RED-M", options: { Color: "Red", Size: "M" }, mrp: 99900, sellingPrice: 79900 },
      { sku: "TSH-100-BLU-S", options: { Color: "Blue", Size: "S" }, mrp: 99900, sellingPrice: 69900 },
    ],
    ...overrides,
  };
}

describe("categories", () => {
  it("builds a nested tree and moves subtrees with their paths", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const women = await makeCategory(admin, "Women");
    const kids = await makeCategory(admin, "Kids Wear");
    const tops = await makeCategory(admin, "Tops", women.id);
    const tees = await makeCategory(admin, "Tees", tops.id);
    expect(tees.depth).toBe(2);
    expect(tees.path).toBe(`/${women.id}/${tops.id}/${tees.id}/`);

    await admin.put(`/api/categories/${tops.id}`).send({ name: "Tops", parentId: kids.id }).expect(200);
    const moved = await prisma.category.findUniqueOrThrow({ where: { id: tees.id } });
    expect(moved.path).toBe(`/${kids.id}/${tops.id}/${tees.id}/`);

    const cycle = await admin.put(`/api/categories/${kids.id}`).send({ name: "Kids Wear", parentId: tees.id }).expect(400);
    expect(cycle.body.message).toMatch(/inside itself/);

    const tree = await admin.get("/api/categories").expect(200);
    const kidsNode = tree.body.data.find((n: { id: string }) => n.id === kids.id);
    expect(kidsNode.children[0].children[0].name).toBe("Tees");
  });

  it("refuses to delete a category that still has products", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    await admin.post("/api/products").send(productBody(cat.id)).expect(201);
    const res = await admin.delete(`/api/categories/${cat.id}`).expect(409);
    expect(res.body.message).toMatch(/product/);
  });
});

describe("products and variants", () => {
  it("creates a product with variants, option links and a derived from-price", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const res = await admin.post("/api/products").send(productBody(cat.id)).expect(201);
    const p = res.body.data;
    expect(p.slug).toBe("relaxed-tee");
    expect(p.sellingPrice).toBe(69900); // cheapest active variant
    expect(p.variants).toHaveLength(3);
    expect(p.variants[0]).toMatchObject({ sku: "TSH-100-RED-S", title: "Red / S", options: { Color: "Red", Size: "S" }, isDefault: true });
    expect(await prisma.auditLog.count({ where: { action: "product.create", entityId: p.id } })).toBe(1);
  });

  it("stores only allow-listed HTML in descriptions", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const description = `<p onclick="steal()">Soft <strong>cotton</strong></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><ul><li>Pre-shrunk</li></ul>`;
    const res = await admin.post("/api/products").send(productBody(cat.id, { description })).expect(201);
    const stored = (await prisma.product.findUniqueOrThrow({ where: { id: res.body.data.id } })).description!;
    expect(stored).toBe(`<p>Soft <strong>cotton</strong></p><a rel="noopener noreferrer nofollow">x</a><ul><li>Pre-shrunk</li></ul>`);
  });

  it("treats every description from the rich text editor the same way: safe HTML, limited by its text", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const typed = `<p onclick="steal()">Hand <strong>block</strong> print &amp; <s>plain</s> dye</p><script>alert(1)</script><img src=x onerror=alert(1)>`;
    const clean = `<p>Hand <strong>block</strong> print &amp; <s>plain</s> dye</p>`;

    const category = (await admin.post("/api/categories").send({ name: "Kurti Sets", description: typed }).expect(201)).body.data;
    expect(category.description).toBe(clean);
    const brand = (await admin.post("/api/brands").send({ name: "Trendz Studio", description: typed }).expect(201)).body.data;
    expect(brand.description).toBe(clean);

    // Short description: rich on the product page, plain text where a meta description is built from it.
    const product = (await admin.post("/api/products").send(productBody(category.id, { shortDescription: typed })).expect(201)).body.data;
    const anon = await client();
    const detail = (await anon.get(`/api/store/products/${product.slug}`).expect(200)).body.data;
    expect(detail.shortDescription).toBe(clean);
    expect(detail.seo.description).toBe("Hand block print & plain dye");

    // What an editor holds when it looks empty is stored as nothing.
    const empty = (await admin.post("/api/categories").send({ name: "Lehenga", description: "<p><br></p>" }).expect(201)).body.data;
    expect(empty.description).toBeNull();

    // The limit counts the words, not the markup around them (roles allow 300 characters).
    const { client: owner } = await loginAs(["SUPER_ADMIN"]);
    const role = { code: "STYLIST", name: "Stylist", permissions: [] };
    const exactly300 = `<p><strong>${"a".repeat(150)}</strong> <em>${"b".repeat(149)}</em></p>`;
    await owner.post("/api/roles").send({ ...role, description: exactly300 }).expect(201);
    const tooLong = await owner.post("/api/roles").send({ ...role, code: "STYLIST_2", description: `<p>${"a".repeat(301)}</p>` }).expect(400);
    expect(tooLong.body.errors[0]).toMatchObject({ path: "description", message: "Keep this to 300 characters or fewer" });
  });

  it("validates prices, option combinations and SKU uniqueness", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);

    const bad = await admin
      .post("/api/products")
      .send(
        productBody(cat.id, {
          variants: [
            { sku: "A-1", options: { Color: "Red", Size: "S" }, mrp: 1000, sellingPrice: 2000 },
            { sku: "A-1", options: { Color: "Red", Size: "S" }, mrp: 1000, sellingPrice: 900 },
            { sku: "A-3", options: { Color: "Green", Size: "S" }, mrp: 1000, sellingPrice: 900 },
          ],
        }),
      )
      .expect(400);
    const messages = bad.body.errors.map((e: { message: string }) => e.message).join(" | ");
    expect(messages).toMatch(/cannot exceed MRP/);
    expect(messages).toMatch(/Duplicate SKU/);
    expect(messages).toMatch(/not a value of Color/);

    await admin.post("/api/products").send(productBody(cat.id)).expect(201);
    const dup = await admin.post("/api/products").send(productBody(cat.id, { name: "Other", baseSku: "TSH-200" })).expect(409);
    expect(dup.body.code).toBe("DUPLICATE_SKU");
  });

  it("requires codes.manage to change a SKU and keeps product codes in sync", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const created = (await admin.post("/api/products").send(productBody(cat.id)).expect(201)).body.data;
    const variant = created.variants[0];
    await prisma.productCode.create({ data: { productId: created.id, variantId: variant.id, sku: variant.sku, codeType: "CODE128", codeValue: variant.sku } });

    const body = productBody(cat.id);
    body.variants = created.variants.map((v: { id: string; sku: string; options: Record<string, string> }, i: number) => ({
      id: v.id,
      sku: i === 0 ? "TSH-100-RED-SM" : v.sku,
      options: v.options,
      mrp: 99900,
      sellingPrice: 79900,
    }));

    const { client: manager } = await loginAs(["INVENTORY_MANAGER"]);
    await manager.put(`/api/products/${created.id}`).send(body).expect(403); // no products.write

    const updated = await admin.put(`/api/products/${created.id}`).send(body).expect(200);
    expect(updated.body.data.variants[0].sku).toBe("TSH-100-RED-SM");
    const code = await prisma.productCode.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(code.sku).toBe("TSH-100-RED-SM");
    expect(await prisma.auditLog.count({ where: { action: "variant.sku_change" } })).toBe(1);
  });

  it("discontinues (not deletes) removed variants that have history", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const created = (await admin.post("/api/products").send(productBody(cat.id)).expect(201)).body.data;
    const [keep1, keep2, withHistory] = created.variants;
    const wh = await prisma.warehouse.findFirstOrThrow();
    await prisma.inventoryTransaction.create({
      data: { variantId: withHistory.id, warehouseId: wh.id, sku: withHistory.sku, type: "ADJUSTMENT", bucket: "ON_HAND", quantity: 1, balanceBefore: 0, balanceAfter: 1 },
    });

    const body = productBody(cat.id);
    body.variants = [keep1, keep2].map((v: { id: string; sku: string; options: Record<string, string> }) => ({ id: v.id, sku: v.sku, options: v.options, mrp: 99900, sellingPrice: 79900 }));
    const res = await admin.put(`/api/products/${created.id}`).send(body).expect(200);
    const statuses = Object.fromEntries(res.body.data.variants.map((v: { sku: string; status: string }) => [v.sku, v.status]));
    expect(statuses[withHistory.sku]).toBe("DISCONTINUED");

    // Deleting a product with history archives it instead.
    const del = await admin.delete(`/api/products/${created.id}`).expect(200);
    expect(del.body.data).toEqual({ deleted: false, archived: true });
  });
});

describe("product images", () => {
  it("uploads through a presigned URL and produces WebP/AVIF sizes, discarding the original", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const product = (await admin.post("/api/products").send(productBody(cat.id)).expect(201)).body.data;

    const png = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#c33" } }).png().toBuffer();
    const presign = await admin
      .post(`/api/products/${product.id}/images/upload-url`)
      .send({ fileName: "tee.png", contentType: "image/png", size: png.length, altText: "Red tee" })
      .expect(201);
    const put = await fetch(presign.body.data.uploadUrl, { method: "PUT", headers: presign.body.data.headers, body: png });
    expect(put.status).toBe(200);

    const imageId = presign.body.data.image.id;
    await admin.post(`/api/products/${product.id}/images/${imageId}/complete`).send({}).expect(200);
    expect((await latestJob("media", "image.process"))?.data).toEqual({ imageId });

    await processImage(imageId); // what the worker does
    const img = await prisma.productImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(img.status).toBe("READY");
    expect(img.width).toBe(1600); // resized, never upscaled beyond the large size
    const sizes = img.sizes as Record<string, { key: string; url: string }>;
    expect(Object.keys(sizes).sort()).toEqual(["large", "largeAvif", "medium", "mediumAvif", "thumb"]);
    expect(await storage().head(img.objectKey)).toBeNull(); // original deleted
    const served = await fetch(sizes.thumb!.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");

    await storage().delete(Object.values(sizes).map((s) => s.key));
  });

  it("rejects oversize and non-image uploads", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin);
    const product = (await admin.post("/api/products").send(productBody(cat.id)).expect(201)).body.data;
    await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.gif", contentType: "image/gif", size: 100 }).expect(400);
    await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: 50 * 1024 * 1024 }).expect(400);

    // One limit for every picture: 2 MB is accepted, one byte more is refused before anything is uploaded.
    const limit = 2 * 1024 * 1024;
    const refused = await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: limit + 1 }).expect(400);
    expect(JSON.stringify(refused.body)).toContain("Images must be at most 2 MB");
    await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: limit }).expect(201);
    for (const purpose of ["category", "brand", "content"]) {
      const over = await admin.post("/api/uploads/presign").send({ purpose, contentType: "image/png", size: limit + 1 }).expect(400);
      expect(JSON.stringify(over.body)).toContain("Images must be at most 2 MB");
      await admin.post("/api/uploads/presign").send({ purpose, contentType: "image/png", size: limit }).expect(200);
    }
  });
});

describe("storefront", () => {
  it("lists only active products, searches by name and SKU, filters and sorts", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const cat = await makeCategory(admin, "Tops");
    await admin.post("/api/products").send(productBody(cat.id)).expect(201);
    await admin
      .post("/api/products")
      .send(productBody(cat.id, {
        name: "Linen Shirt",
        baseSku: "SHR-200",
        options: [],
        variants: [{ sku: "SHR-200", options: {}, mrp: 250000, sellingPrice: 199900 }],
      }))
      .expect(201);
    await admin.post("/api/products").send(productBody(cat.id, { name: "Draft Item", baseSku: "DRF-1", status: "DRAFT", options: [], variants: [{ sku: "DRF-1", options: {}, mrp: 100, sellingPrice: 100 }] })).expect(201);

    const anon = await client();
    const all = await anon.get("/api/store/products").expect(200);
    expect(all.body.meta.total).toBe(2);

    const byName = await anon.get("/api/store/products?q=linen").expect(200);
    expect(byName.body.data.map((p: { name: string }) => p.name)).toEqual(["Linen Shirt"]);

    const bySku = await anon.get("/api/store/products?q=tsh-100-blu").expect(200);
    expect(bySku.body.data.map((p: { name: string }) => p.name)).toEqual(["Relaxed Tee"]);

    const cheap = await anon.get("/api/store/products?maxPrice=100000&sort=price_asc").expect(200);
    expect(cheap.body.data.map((p: { name: string }) => p.name)).toEqual(["Relaxed Tee"]);

    const byOption = await anon.get("/api/store/products?opt.Color=Blue").expect(200);
    expect(byOption.body.data).toHaveLength(1);

    const inStock = await anon.get("/api/store/products?inStock=true").expect(200);
    expect(inStock.body.meta.total).toBe(0); // nothing stocked yet

    const facets = await anon.get(`/api/store/products/facets?category=${cat.slug}`).expect(200);
    expect(facets.body.data.price).toEqual({ min: 69900, max: 199900 });
    expect(facets.body.data.options.find((o: { name: string }) => o.name === "Size").values).toEqual([
      { value: "S", count: 1 },
      { value: "M", count: 1 },
    ]);

    const detail = await anon.get("/api/store/products/relaxed-tee").expect(200);
    expect(detail.body.data.variants[0]).toMatchObject({ sku: "TSH-100-RED-S", inStock: false });
    expect(detail.body.data.breadcrumb.map((b: { name: string }) => b.name)).toEqual(["Tops"]);
    await anon.get("/api/store/products/draft-item").expect(404);
  });

  it("answers not-found as a 200 only when a GET asks for it (the storefront's page cache needs one)", async () => {
    const anon = await client();
    const plain = await anon.get("/api/store/products/no-such-product").expect(404);
    expect(plain.body).toMatchObject({ success: false, code: "NOT_FOUND" });

    const soft = await anon.get("/api/store/products/no-such-product").set("X-Not-Found-Status", "200").expect(200);
    expect(soft.body).toMatchObject({ success: false, code: "NOT_FOUND", message: "Product not found" });
    expect(soft.headers["cache-control"]).toBe("no-store");
    await anon.get("/api/store/categories/no-such-category").set("X-Not-Found-Status", "200").expect(200);

    // Other errors and other methods keep their status.
    await anon.get("/api/users").set("X-Not-Found-Status", "200").expect(401);
    const { client: admin } = await loginAs(["ADMIN"]);
    await admin.delete("/api/categories/00000000-0000-4000-8000-000000000000").set("X-Not-Found-Status", "200").expect(404);
  });
});
