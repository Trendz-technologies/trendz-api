import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { moveDemoProductsToCollections, removeRetiredDemoCategories, removeRetiredDemoProducts } from "../prisma/seed-demo";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import { createCategory } from "../src/modules/catalog/categories.service";
import { adjustStock } from "../src/modules/inventory/inventory.service";
import { createPurchaseOrder } from "../src/modules/purchasing/purchase-orders.service";
import { loginAs, resetDatabase, type TestClient } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

/** A one-variant product, created the way an admin would. */
async function product(admin: TestClient, baseSku: string, name: string, categoryId: string) {
  const res = await admin
    .post("/api/products")
    .send({ name, baseSku, categoryId, status: "ACTIVE", options: [{ name: "Size", values: ["M"] }], variants: [{ sku: `${baseSku}-M`, options: { Size: "M" }, mrp: 249900, sellingPrice: 219900 }] })
    .expect(201);
  return { id: res.body.data.id as string, variantId: res.body.data.variants[0].id as string };
}

const ledgerRows = (variantId: string) => prisma.inventoryTransaction.count({ where: { variantId } });
const categorySlug = async (productId: string) => (await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { category: { select: { slug: true } } } })).category.slug;

describe("demo seed: retiring the men's catalogue", () => {
  it("removes men's demo products with their demo stock, keeps history, and moves the rest to the shop's collections", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const warehouse = await prisma.warehouse.findFirstOrThrow();

    // The tree older seeds created (no user in the audit trail) …
    const men = await createCategory({ name: "Men", slug: "men", sortOrder: 1 }, systemContext);
    const menShirts = await createCategory({ name: "Shirts", slug: "men-shirts", parentId: men.id, sortOrder: 0 }, systemContext);
    const menBottoms = await createCategory({ name: "Bottoms", slug: "men-bottoms", parentId: men.id, sortOrder: 1 }, systemContext);
    const women = await createCategory({ name: "Women", slug: "women", sortOrder: 0 }, systemContext);
    const womenTops = await createCategory({ name: "Tops", slug: "women-tops", parentId: women.id, sortOrder: 0 }, systemContext);
    // … and a category an admin happened to give one of the old slugs.
    await admin.post("/api/categories").send({ name: "Unisex", slug: "unisex" }).expect(201);

    const shirt = await product(admin, "MSH-1003", "Ink Linen Shirt", menShirts.id); // men's, demo rows only
    const trousers = await product(admin, "MBT-1017", "Pleated High-Waist Trousers", menBottoms.id); // men's, with real history
    const top = await product(admin, "WTP-1014", "Halter Rib Top", womenTops.id); // women's: stays

    await adjustStock(
      { warehouseId: warehouse.id, reason: "OPENING_STOCK", notes: "Demo opening stock", items: [shirt, trousers, top].map((p) => ({ variantId: p.variantId, mode: "set" as const, quantity: 9, bucket: "ON_HAND" as const })) },
      systemContext,
    );
    const supplier = await prisma.supplier.create({ data: { code: "SUP-001", name: "Tiruppur Knit Works" } });
    const demoPo = await createPurchaseOrder({ supplierId: supplier.id, warehouseId: warehouse.id, shippingCost: 0, notes: "Demo restock", items: [{ variantId: shirt.variantId, quantity: 20, unitCost: 45000, taxRateBps: 500 }] }, systemContext);
    // A purchase order someone raised themselves is business history.
    const realPo = await createPurchaseOrder({ supplierId: supplier.id, warehouseId: warehouse.id, shippingCost: 0, notes: "Diwali restock", items: [{ variantId: trousers.variantId, quantity: 5, unitCost: 60000, taxRateBps: 500 }] }, systemContext);
    expect(await ledgerRows(shirt.variantId)).toBe(1);

    await removeRetiredDemoProducts(prisma);

    // Demo-only product: gone, with its stock rows and the demo purchase order.
    expect(await prisma.product.findUnique({ where: { id: shirt.id } })).toBeNull();
    expect(await ledgerRows(shirt.variantId)).toBe(0);
    expect(await prisma.inventoryLevel.count({ where: { variantId: shirt.variantId } })).toBe(0);
    expect(await prisma.purchaseOrder.findUnique({ where: { id: demoPo.id } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "product.delete", entityId: shirt.id } })).toBe(1);

    // Product with history: archived, nothing of it deleted.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: trousers.id } })).status).toBe("ARCHIVED");
    expect(await ledgerRows(trousers.variantId)).toBe(1);
    expect(await prisma.purchaseOrder.findUnique({ where: { id: realPo.id } })).not.toBeNull();

    // Women's product and its stock are untouched, and the ledger is append-only again.
    expect((await prisma.inventoryLevel.findFirstOrThrow({ where: { variantId: top.variantId } })).onHand).toBe(9);
    expect(await ledgerRows(top.variantId)).toBe(1);
    await expect(prisma.inventoryTransaction.deleteMany({ where: { variantId: top.variantId } })).rejects.toThrow(/append-only/);

    await moveDemoProductsToCollections(prisma);
    expect(await categorySlug(top.id)).toBe("western-wear");
    expect(await categorySlug(trousers.id)).toBe("men-bottoms"); // not part of the catalogue any more, so not moved

    await removeRetiredDemoCategories(prisma);
    const left = (await prisma.category.findMany({ select: { slug: true } })).map((c) => c.slug).sort();
    // Emptied seed categories are gone; the archived product's branch and the admin's own category stay.
    expect(left).toEqual(["men", "men-bottoms", "unisex", "western-wear"]);

    // Running it all again changes nothing.
    await removeRetiredDemoProducts(prisma);
    await moveDemoProductsToCollections(prisma);
    await removeRetiredDemoCategories(prisma);
    expect(await prisma.product.count()).toBe(2);
    expect((await prisma.category.findMany({ select: { slug: true } })).map((c) => c.slug).sort()).toEqual(left);
  });
});
