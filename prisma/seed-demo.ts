/**
 * Development-only demo data. Never runs in production (see seed.ts).
 * Creates a small but realistic women's wear catalog with images, so every
 * screen of the storefront, admin and POS has something to show.
 *
 * Trendz sells women's and girls' wear only. Databases seeded before that was
 * settled also hold men's products and a Women / Men / Unisex category tree;
 * running the seed again removes those (see removeRetiredDemoProducts).
 */
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { storage } from "../src/integrations/object-storage";
import { invalidate } from "../src/database/redis";
import { enqueue, QUEUE_NAMES } from "../src/jobs/queues";
import { audit, systemContext } from "../src/modules/audit/audit.service";
import { createCategory, deleteCategory } from "../src/modules/catalog/categories.service";
import { createProduct, deleteProduct, productCacheKey } from "../src/modules/catalog/products.service";
import { imageKeys } from "../src/modules/media/image-view";
import { processImage } from "../src/modules/media/images.service";
import type { ProductInput } from "../src/modules/catalog/products.schemas";
import { adjustStock } from "../src/modules/inventory/inventory.service";
import { createPurchaseOrder, transitionPurchaseOrder } from "../src/modules/purchasing/purchase-orders.service";

const ASSETS = path.join(__dirname, "demo-assets");

/** The shop's collections, as on its signboard. Each one is a top-level category. */
const COLLECTIONS = [
  { slug: "kurti-sets", name: "Kurti Sets" },
  { slug: "anarkali", name: "Anarkali" },
  { slug: "western-wear", name: "Western Wear" },
  { slug: "lehenga", name: "Lehenga" },
  { slug: "party-wear", name: "Party Wear" },
  { slug: "kids-wear", name: "Kids Wear" },
] as const;
type CollectionSlug = (typeof COLLECTIONS)[number]["slug"];

/** Men's demo products from earlier versions of this seed (base SKUs). */
const RETIRED_PRODUCT_CODES = ["MSH-1003", "UHD-1006", "MOW-1007", "MSH-1013", "MBT-1016", "MBT-1017", "UHD-1018", "MSH-1020"];

/** The category tree earlier versions created. Children are listed before their parents. */
const RETIRED_CATEGORY_SLUGS = [
  "men-shirts", "men-bottoms", "men-outerwear", "men",
  "unisex-tees", "unisex-hoodies", "unisex-sets", "unisex",
  "women-tops", "women-bottoms", "women-knitwear", "women-sets", "women-outerwear", "women",
];

/** The purchase order this seed raises (see seedDemoInventory). */
const DEMO_PO_NOTES = "Demo restock";
const DEMO_SUPPLIER_CODE = "SUP-001";

const COLOR_CODES: Record<string, string> = {
  Black: "BLK", Brown: "BRN", Cream: "CRM", Ecru: "ECR", Navy: "NVY", Forest: "FST", Grey: "GRY", Ink: "INK", Sage: "SGE",
  Berry: "BRY", Pink: "PNK", Charcoal: "CHR", Maroon: "MRN", Stone: "STN", Indigo: "IND", "Light Wash": "LTW", Red: "RED",
  Olive: "OLV", White: "WHT", Teal: "TEA", Khaki: "KHK", Crimson: "CRI", Rust: "RST", Camel: "CML", Blue: "BLU",
};

interface DemoProduct {
  name: string;
  code: string;
  category: CollectionSlug;
  brand: string;
  mrp: number; // rupees
  price: number; // rupees
  colors: string[];
  sizes: string[];
  image: string;
  type: string;
  hsn: string;
  tags: string[];
  featured?: boolean;
  description: string;
}

const APPAREL_SIZES = ["XS", "S", "M", "L", "XL"];
const WAIST_SIZES = ["28", "30", "32", "34", "36"];

const PRODUCTS: DemoProduct[] = [
  { name: "Chaotic Star Cargo Set", code: "UST-1001", category: "western-wear", brand: "Trendz", mrp: 5999, price: 4999, colors: ["Navy", "Ecru", "Black"], sizes: APPAREL_SIZES, image: "chaotic-star-cargo-set.png", type: "Co-ord set", hsn: "6203", tags: ["streetwear", "denim", "new"], featured: true, description: "A graphic tee and hand-painted star cargo pant set — distressed wide-leg denim paired with an oversized printed jersey top." },
  { name: "Unbroken Relaxed Tee", code: "UTE-1002", category: "western-wear", brand: "Trendz", mrp: 1799, price: 1499, colors: ["Forest", "Cream", "Grey"], sizes: APPAREL_SIZES, image: "unbroken-relaxed-tee.png", type: "T-shirt", hsn: "6109", tags: ["tee", "cotton", "oversized"], featured: true, description: "Relaxed-fit crest tee in washed cotton jersey, styled with a dropped shoulder seam and ribbed collar for everyday off-duty wear." },
  { name: "Unbroken Stripe Tee", code: "UTE-1004", category: "western-wear", brand: "Trendz", mrp: 1899, price: 1599, colors: ["Berry", "Pink", "Black"], sizes: APPAREL_SIZES, image: "unbroken-stripe-tee.png", type: "T-shirt", hsn: "6109", tags: ["tee", "stripes", "oversized"], description: "Bold stripe crest tee in oversized cotton jersey, dropped shoulder and curved hem for a lived-in streetwear fit." },
  { name: "Midnight Cami Set", code: "WST-1005", category: "party-wear", brand: "Trendz Studio", mrp: 5499, price: 4799, colors: ["Black", "Charcoal", "Ecru"], sizes: APPAREL_SIZES, image: "midnight-cami-set.png", type: "Co-ord set", hsn: "6204", tags: ["evening", "co-ord"], featured: true, description: "A ribbed cami top paired with belted wide-leg trousers — a fluid, tonal set designed to be worn together or separately." },
  { name: "Wide-Leg Denim", code: "WBT-1008", category: "western-wear", brand: "Trendz", mrp: 3499, price: 2799, colors: ["Light Wash", "Indigo"], sizes: WAIST_SIZES, image: "wide-leg-denim.jpg", type: "Jeans", hsn: "6204", tags: ["denim", "wide-leg"], featured: true, description: "High-rise, full-length wide-leg jeans in rigid cotton denim with a clean front and a puddle hem." },
  { name: "Ribbed Turtleneck Sweater", code: "WKN-1009", category: "western-wear", brand: "Trendz Studio", mrp: 3299, price: 2999, colors: ["Red", "Cream", "Black"], sizes: APPAREL_SIZES, image: "ribbed-turtleneck.jpg", type: "Sweater", hsn: "6110", tags: ["knit", "winter"], description: "A chunky rib-knit turtleneck in a soft wool blend with a relaxed body and long, stacked sleeves." },
  { name: "Heartfelt Graphic Tee", code: "UTE-1010", category: "western-wear", brand: "Trendz", mrp: 1499, price: 1299, colors: ["White", "Black"], sizes: APPAREL_SIZES, image: "heartfelt-graphic-tee.jpg", type: "T-shirt", hsn: "6109", tags: ["tee", "graphic"], description: "Heavyweight boxy tee with a soft-hand front print. Pairs with everything from baggy denim to cargos." },
  { name: "Tailored Blazer Suit Set", code: "WST-1011", category: "party-wear", brand: "Trendz Studio", mrp: 8999, price: 7499, colors: ["Rust", "Black"], sizes: APPAREL_SIZES, image: "tailored-suit-set.jpg", type: "Suit", hsn: "6204", tags: ["tailoring", "occasion"], featured: true, description: "A single-breasted blazer with matching straight-leg trousers in a fluid suiting fabric." },
  { name: "Off-Shoulder Knit Top", code: "WTP-1012", category: "party-wear", brand: "Nomad Lane", mrp: 1999, price: 1699, colors: ["Brown", "Black", "Cream"], sizes: APPAREL_SIZES, image: "off-shoulder-top.jpg", type: "Top", hsn: "6206", tags: ["knit", "evening"], description: "A fitted, fine-rib knit top with an asymmetric off-shoulder neckline and long sleeves." },
  { name: "Halter Rib Top", code: "WTP-1014", category: "western-wear", brand: "Trendz", mrp: 1299, price: 999, colors: ["Brown", "Black"], sizes: APPAREL_SIZES, image: "halter-rib-top.jpg", type: "Top", hsn: "6206", tags: ["rib", "summer"], description: "A stretch-rib halter top with a high neck and clean finish. Tuck it into wide-leg denim." },
  { name: "Puff Sleeve Corset Top", code: "WTP-1015", category: "party-wear", brand: "Trendz Studio", mrp: 1999, price: 1599, colors: ["White", "Black"], sizes: APPAREL_SIZES, image: "puff-sleeve-top.jpg", type: "Top", hsn: "6206", tags: ["corset", "party"], description: "A structured corset-style top with sweetheart neckline and soft puff sleeves." },
  { name: "Cropped Denim Jacket", code: "WOW-1019", category: "western-wear", brand: "Trendz", mrp: 3999, price: 3499, colors: ["Light Wash", "Indigo"], sizes: APPAREL_SIZES, image: "cropped-denim-jacket.jpg", type: "Jacket", hsn: "6202", tags: ["denim", "layering"], description: "A cropped trucker jacket in mid-weight denim with chest flap pockets and a boxy fit." },
];

async function uploadDemoImage(prisma: PrismaClient, productId: string, file: string, alt: string) {
  const buffer = fs.readFileSync(path.join(ASSETS, file));
  const contentType = file.endsWith(".png") ? "image/png" : "image/jpeg";
  const image = await prisma.productImage.create({
    data: { productId, objectKey: `uploads/products/${productId}/demo/${Date.now().toString(36)}`, altText: alt, sortOrder: 0, status: "PROCESSING", mimeType: contentType, bytes: buffer.length },
  });
  const objectKey = `uploads/products/${productId}/${image.id}/${Date.now().toString(36)}`;
  await prisma.productImage.update({ where: { id: image.id }, data: { objectKey } });
  await storage().put(objectKey, buffer, contentType, "private, no-store");
  await processImage(image.id); // same pipeline the worker runs
}

/**
 * Resumable: a run that was interrupted (e.g. object storage went away mid-way)
 * is completed by running the seed again. Nothing that exists is changed.
 */
export async function seedDemoData(prisma: PrismaClient): Promise<void> {
  await removeRetiredDemoProducts(prisma);
  const demoCodes = PRODUCTS.map((p) => p.code);
  const [total, demo] = await Promise.all([prisma.product.count(), prisma.product.count({ where: { baseSku: { in: demoCodes } } })]);
  if (total > demo) {
    console.log("• demo catalog skipped (the catalog has non-demo products)");
  } else {
    await seedDemoCatalog(prisma);
  }
  await moveDemoProductsToCollections(prisma);
  await removeRetiredDemoCategories(prisma);
  await seedDemoInventory(prisma);
}

const ensureCollection = async (prisma: PrismaClient, slug: CollectionSlug) =>
  (await prisma.category.findUnique({ where: { slug }, select: { id: true } })) ??
  (await createCategory({ name: COLLECTIONS.find((c) => c.slug === slug)!.name, slug, sortOrder: COLLECTIONS.findIndex((c) => c.slug === slug) }, systemContext));

/**
 * Removes the men's demo products that earlier versions of this seed created.
 *
 * A product that was sold, returned, transferred, rung up at the counter or
 * received from a supplier is business history and is archived instead. The
 * rest only has rows this seed wrote itself (opening stock and the demo
 * purchase order), and is deleted together with them.
 */
export async function removeRetiredDemoProducts(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const retired = await prisma.product.findMany({ where: { baseSku: { in: RETIRED_PRODUCT_CODES } }, include: { variants: { select: { id: true } }, images: true } });
  if (!retired.length) return;

  const demoPurchaseOrder = { notes: DEMO_PO_NOTES, supplier: { code: DEMO_SUPPLIER_CODE } };
  let deleted = 0;
  let archived = 0;
  for (const product of retired) {
    const where = { variantId: { in: product.variants.map((v) => v.id) } };
    const history = await Promise.all([
      prisma.orderItem.count({ where }),
      prisma.returnItem.count({ where }),
      prisma.stockTransferItem.count({ where }),
      prisma.posCartItem.count({ where }),
      prisma.goodsReceiptItem.count({ where }),
      prisma.purchaseOrderItem.count({ where: { ...where, purchaseOrder: { NOT: demoPurchaseOrder } } }),
    ]);
    if (history.some(Boolean)) {
      if (product.status !== "ARCHIVED") await deleteProduct(product.id, systemContext); // archives: the product has history
      archived++;
      continue;
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.purchaseOrder.deleteMany({ where: { ...demoPurchaseOrder, items: { some: where } } });
        await tx.stockReservation.deleteMany({ where });
        await tx.stockAdjustmentItem.deleteMany({ where });
        await tx.inventoryLevel.deleteMany({ where });
        // The stock ledger is append-only: a trigger rejects deletes. These rows are the
        // demo opening stock of a demo product, so the trigger is lifted for this one
        // statement (and restored by the rollback if anything here fails).
        await tx.$executeRawUnsafe(`ALTER TABLE "inventory_transactions" DISABLE TRIGGER "inventory_transactions_append_only"`);
        await tx.inventoryTransaction.deleteMany({ where });
        await tx.$executeRawUnsafe(`ALTER TABLE "inventory_transactions" ENABLE TRIGGER "inventory_transactions_append_only"`);
        await tx.product.delete({ where: { id: product.id } });
        await audit(tx, systemContext, {
          action: "product.delete",
          entityType: "product",
          entityId: product.id,
          oldValue: { name: product.name, baseSku: product.baseSku, reason: "Men's demo product retired: the shop sells women's and girls' wear only" },
        });
      },
      { timeout: 60_000 },
    );
    if (product.images.length) await enqueue(QUEUE_NAMES.media, "image.delete-objects", { keys: product.images.flatMap(imageKeys) });
    await invalidate(productCacheKey(product.slug));
    deleted++;
  }
  console.log(`✔ men's demo products: ${deleted} removed${archived ? `, ${archived} archived (they have sales or stock history)` : ""}`);
}

/** Demo products seeded under the old Women / Unisex tree move to the shop's collections. */
export async function moveDemoProductsToCollections(prisma: PrismaClient): Promise<void> {
  const stale = await prisma.product.findMany({
    where: { baseSku: { in: PRODUCTS.map((p) => p.code) }, category: { slug: { in: RETIRED_CATEGORY_SLUGS } } },
    select: { id: true, baseSku: true, slug: true, categoryId: true },
  });
  for (const product of stale) {
    const target = await ensureCollection(prisma, PRODUCTS.find((d) => d.code === product.baseSku)!.category);
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: product.id }, data: { categoryId: target.id } });
      await audit(tx, systemContext, { action: "product.update", entityType: "product", entityId: product.id, oldValue: { categoryId: product.categoryId }, newValue: { categoryId: target.id } });
    });
    await invalidate(productCacheKey(product.slug));
  }
  if (stale.length) console.log(`✔ demo products: ${stale.length} moved to the shop's collections`);
}

/** Deletes the old Women / Men / Unisex tree, leaving anything that is still in use or that someone else created. */
export async function removeRetiredDemoCategories(prisma: PrismaClient): Promise<void> {
  let removed = 0;
  const kept: string[] = [];
  for (const slug of RETIRED_CATEGORY_SLUGS) {
    const category = await prisma.category.findUnique({ where: { slug }, select: { id: true, _count: { select: { products: true, children: true } } } });
    if (!category) continue;
    // Only categories this seed created (the audit trail shows no user), and only once they are empty.
    const seeded = await prisma.auditLog.count({ where: { action: "category.create", entityId: category.id, userId: null } });
    if (!seeded || category._count.products || category._count.children) {
      kept.push(slug);
      continue;
    }
    await deleteCategory(category.id, systemContext);
    removed++;
  }
  if (removed || kept.length) console.log(`✔ old demo categories: ${removed} removed${kept.length ? `, kept ${kept.join(", ")} (still in use)` : ""}`);
}

/** Opening stock in two locations, a supplier and an approved purchase order. */
async function seedDemoInventory(prisma: PrismaClient) {
  const main = await prisma.warehouse.findFirstOrThrow({ where: { code: "WH-001" } });
  const store =
    (await prisma.warehouse.findUnique({ where: { code: "WH-002" } })) ??
    (await prisma.warehouse.create({
      data: {
        code: "WH-002",
        name: "City Store (POS)",
        addressLine1: "14 Khader Nawaz Khan Road",
        city: "Chennai",
        state: "Tamil Nadu",
        stateCode: "33",
        postalCode: "600006",
        isOnlineFulfillment: false,
        priority: 50,
      },
    }));

  // Only variants that have never had stock in a location get opening stock there.
  const variants = await prisma.productVariant.findMany({ select: { id: true, sku: true, inventoryLevels: { select: { warehouseId: true } } }, orderBy: { sku: "asc" } });
  const without = (warehouseId: string) => variants.filter((v) => !v.inventoryLevels.some((l) => l.warehouseId === warehouseId));
  // Deterministic pseudo-random quantities so every reseed looks the same.
  const qty = (sku: string, salt: number) => [...sku].reduce((h, c) => (h * 31 + c.charCodeAt(0) + salt) % 997, 7) % 18;
  const mainItems = without(main.id).map((v) => ({ variantId: v.id, mode: "set" as const, quantity: qty(v.sku, 1) === 0 ? 0 : qty(v.sku, 1) + 2, bucket: "ON_HAND" as const }));
  const storeItems = without(store.id)
    .filter((v) => qty(v.sku, 3) % 3 === 0)
    .map((v) => ({ variantId: v.id, mode: "set" as const, quantity: qty(v.sku, 2) % 6, bucket: "ON_HAND" as const }));
  for (const [warehouse, items] of [[main, mainItems], [store, storeItems]] as const) {
    for (let i = 0; i < items.length; i += 500) {
      await adjustStock({ warehouseId: warehouse.id, reason: "OPENING_STOCK", notes: "Demo opening stock", items: items.slice(i, i + 500) }, systemContext);
    }
  }

  const supplier =
    (await prisma.supplier.findUnique({ where: { code: DEMO_SUPPLIER_CODE } })) ??
    (await prisma.supplier.create({
      data: {
        code: DEMO_SUPPLIER_CODE,
        name: "Tiruppur Knit Works",
        companyName: "Tiruppur Knit Works Pvt Ltd (demo)",
        contactPerson: "R. Senthil",
        phone: "+919800000001",
        email: "orders@tkw.example",
        gstin: "33AABCT1332L1ZQ",
        city: "Tiruppur",
        state: "Tamil Nadu",
        stateCode: "33",
        paymentTermsDays: 30,
        paymentTerms: "Net 30",
      },
    }));
  let poNote = "existing purchase order kept";
  if (!(await prisma.purchaseOrder.count({ where: { supplierId: supplier.id } })) && variants.length) {
    const po = await createPurchaseOrder(
      {
        supplierId: supplier.id,
        warehouseId: main.id,
        shippingCost: 0,
        notes: DEMO_PO_NOTES,
        items: variants.slice(0, 6).map((v) => ({ variantId: v.id, quantity: 20, unitCost: 45000, taxRateBps: 500 })),
      },
      systemContext,
    );
    await transitionPurchaseOrder(po.id, "submit", systemContext);
    await transitionPurchaseOrder(po.id, "approve", systemContext);
    poNote = `approved ${po.number}`;
  }
  console.log(`✔ demo inventory: opening stock for ${mainItems.length} + ${storeItems.length} variant rows in ${main.code} / ${store.code}, supplier ${supplier.code}, ${poNote}`);
}

async function seedDemoCatalog(prisma: PrismaClient): Promise<void> {
  // Collections (reused when they already exist). All six are created, including the
  // ones without demo products, so the shop's own range has somewhere to go.
  const categoryIds = new Map<CollectionSlug, string>();
  for (const { slug } of COLLECTIONS) categoryIds.set(slug, (await ensureCollection(prisma, slug)).id);

  // Brands
  const brandIds = new Map<string, string>();
  for (const name of ["Trendz", "Trendz Studio", "Nomad Lane"]) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    const b = await prisma.brand.upsert({ where: { slug }, update: {}, create: { name, slug } });
    brandIds.set(name, b.id);
  }

  const apparel = await prisma.taxClass.findUnique({ where: { code: "APPAREL" } });
  let created = 0;
  let imagesRedone = 0;

  for (const d of PRODUCTS) {
    const existing = await prisma.product.findUnique({ where: { baseSku: d.code }, select: { id: true, images: { select: { id: true, status: true } } } });
    if (existing) {
      // Finish an image that an interrupted run left unprocessed.
      if (!existing.images.some((i) => i.status === "READY")) {
        await prisma.productImage.deleteMany({ where: { productId: existing.id, status: { not: "READY" } } });
        await uploadDemoImage(prisma, existing.id, d.image, d.name);
        imagesRedone++;
      }
      continue;
    }
    const variants: ProductInput["variants"] = [];
    for (const color of d.colors) {
      for (const size of d.sizes) {
        variants.push({
          sku: `${d.code}-${COLOR_CODES[color] ?? color.slice(0, 3).toUpperCase()}-${size}`,
          options: { Color: color, Size: size },
          mrp: d.mrp * 100,
          sellingPrice: d.price * 100,
          costPrice: Math.round(d.price * 100 * 0.45),
          weightGrams: d.type === "Co-ord set" || d.type === "Suit" ? 900 : 400,
          status: "ACTIVE",
        });
      }
    }
    const product = await createProduct(
      {
        name: d.name,
        baseSku: d.code,
        description: `<p>${d.description}</p><ul><li>Regular care: machine wash cold, dry in shade</li><li>Model is 5'9" and wears size M</li></ul>`,
        shortDescription: d.description,
        categoryId: categoryIds.get(d.category)!,
        brandId: brandIds.get(d.brand)!,
        productType: d.type,
        status: "ACTIVE",
        taxClassId: apparel?.id ?? null,
        hsnCode: d.hsn,
        minStockLevel: 3,
        weightGrams: 400,
        lengthMm: 300,
        widthMm: 250,
        heightMm: 40,
        tags: d.tags,
        isFeatured: d.featured ?? false,
        seoTitle: `${d.name} | Trendz`,
        seoDescription: d.description.slice(0, 160),
        options: [
          { name: "Color", values: d.colors },
          { name: "Size", values: d.sizes },
        ],
        variants,
      },
      systemContext,
    );
    await uploadDemoImage(prisma, product.id, d.image, d.name);
    created++;
  }
  console.log(`✔ demo catalog: ${created} products created, ${PRODUCTS.length - created} already present${imagesRedone ? `, ${imagesRedone} images re-processed` : ""}`);
}
