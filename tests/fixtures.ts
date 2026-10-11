import { prisma } from "../src/database/prisma";
import { systemContext } from "../src/modules/audit/audit.service";
import { createCategory } from "../src/modules/catalog/categories.service";
import { createProduct } from "../src/modules/catalog/products.service";
import { adjustStock } from "../src/modules/inventory/inventory.service";
import { updateSetting } from "../src/modules/settings/settings.service";
import type { TestClient } from "./helpers";

let seq = 0;

export interface SimpleProduct {
  name?: string;
  price: number; // paise
  mrp?: number;
  stock?: number;
  taxClass?: string; // code, default APPAREL
  categoryId?: string;
}

/** Creates a single-variant ACTIVE product with stock in the default warehouse. */
export async function makeProduct(p: SimpleProduct) {
  seq += 1;
  const categoryId = p.categoryId ?? (await defaultCategory());
  const taxClass = await prisma.taxClass.findUniqueOrThrow({ where: { code: p.taxClass ?? "APPAREL" } });
  const sku = `FX-${Date.now().toString(36).toUpperCase()}-${seq}`;
  const product = await createProduct(
    {
      name: p.name ?? `Fixture ${seq}`,
      baseSku: sku,
      categoryId,
      status: "ACTIVE",
      taxClassId: taxClass.id,
      minStockLevel: 0,
      tags: [],
      isFeatured: false,
      options: [],
      variants: [{ sku, options: {}, mrp: p.mrp ?? p.price, sellingPrice: p.price, status: "ACTIVE" }],
    },
    systemContext,
  );
  const variant = product.variants[0]!;
  if (p.stock) {
    const wh = await prisma.warehouse.findFirstOrThrow({ where: { code: "WH-001" } });
    await adjustStock({ warehouseId: wh.id, reason: "OPENING_STOCK", items: [{ variantId: variant.id, mode: "set", quantity: p.stock, bucket: "ON_HAND" }] }, systemContext);
  }
  return { product, variant, sku };
}

let categoryId: string | null = null;
async function defaultCategory() {
  const existing = await prisma.category.findFirst({ where: { slug: "fixtures" } });
  if (existing) return (categoryId = existing.id);
  categoryId = (await createCategory({ name: "Fixtures", slug: "fixtures" }, systemContext)).id;
  return categoryId;
}

/** The seller is in Tamil Nadu (33) unless changed. */
export async function setStoreState(stateCode: string) {
  await updateSetting("store", { address: { stateCode, state: "", city: "", line1: "", line2: "", postalCode: "", country: "IN" } }, systemContext);
}

export async function addAddress(c: TestClient, state = "Tamil Nadu") {
  const res = await c
    .post("/api/account/addresses")
    .send({ fullName: "Asha Rao", phone: "9876501234", line1: "12 MG Road", city: "City", state, postalCode: "600001" })
    .expect(201);
  return res.body.data as { id: string; stateCode: string };
}

export const level = (variantId: string) =>
  prisma.inventoryLevel.findFirstOrThrow({ where: { variantId, warehouse: { code: "WH-001" } } });
