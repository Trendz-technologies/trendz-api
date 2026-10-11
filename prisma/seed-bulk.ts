/**
 * Performance data for development and staging: adds N products (default 3000)
 * with colour × size variants and opening stock, through the same services the
 * admin uses (validation, option links, from-price, audit). Use it to measure
 * listing, search, filters, POS lookup and reports at a realistic scale.
 *
 *   npm run db:seed:bulk -- 3000
 *
 * Re-running continues numbering after the last bulk product. Bulk products
 * have no images (the storefront shows a placeholder). Refuses to run in
 * production.
 */
import { prisma } from "../src/database/prisma";
import { closeRedis } from "../src/database/redis";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import type { ProductInput } from "../src/modules/catalog/products.schemas";
import { createProduct } from "../src/modules/catalog/products.service";
import { adjustStock } from "../src/modules/inventory/inventory.service";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("seed-bulk is for development / staging only");
  const target = Math.max(1, Math.min(50_000, Number(process.argv[2] ?? 3000) || 3000));
  const concurrency = Math.max(1, Number(process.env.BULK_CONCURRENCY ?? 4));

  try {
    const leaves = await prisma.category.findMany({ where: { isActive: true, children: { none: {} } }, select: { id: true } });
    const categories = leaves.length
      ? leaves.map((c) => c.id)
      : [(await prisma.category.create({ data: { name: "Bulk", slug: "bulk" } })).id];
    const brands = (await prisma.brand.findMany({ select: { id: true } })).map((b) => b.id);
    const taxClass = await prisma.taxClass.findFirst({ where: { code: "APPAREL" }, select: { id: true } });
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { status: "ACTIVE" }, orderBy: { priority: "asc" } });

    const last = await prisma.product.findFirst({ where: { baseSku: { startsWith: "BULK-" } }, orderBy: { baseSku: "desc" }, select: { baseSku: true } });
    const start = last ? Number(last.baseSku.slice(5)) + 1 : 1;

    const ADJ = ["Relaxed", "Boxy", "Tailored", "Washed", "Heavyweight", "Cropped", "Oversized", "Ribbed", "Pleated", "Utility", "Vintage", "Classic", "Everyday", "Studio", "Weekend"];
    const FABRIC = ["Cotton", "Linen", "Denim", "Fleece", "Jersey", "Twill", "Knit", "Corduroy", "Poplin", "Canvas"];
    const ITEM = [
      { name: "Tee", type: "T-shirt", hsn: "6109" },
      { name: "Shirt", type: "Shirt", hsn: "6205" },
      { name: "Hoodie", type: "Hoodie", hsn: "6110" },
      { name: "Trousers", type: "Trousers", hsn: "6203" },
      { name: "Jacket", type: "Jacket", hsn: "6202" },
      { name: "Shorts", type: "Shorts", hsn: "6203" },
      { name: "Sweater", type: "Sweater", hsn: "6110" },
      { name: "Top", type: "Top", hsn: "6206" },
    ];
    const COLORS = ["Black", "White", "Navy", "Olive", "Stone", "Rust", "Sage", "Grey", "Indigo", "Maroon", "Cream", "Teal"];
    const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
    // Deterministic pseudo-random numbers so repeated runs produce the same catalogue.
    const rnd = (n: number, salt: number) => Math.abs(Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453) % 1;
    const pick = <T>(list: T[], n: number, salt: number) => list[Math.floor(rnd(n, salt) * list.length)]!;

    const started = Date.now();
    let created = 0;
    const variantIds: string[] = [];

    const build = async (n: number) => {
      const code = `BULK-${String(n).padStart(6, "0")}`;
      const item = pick(ITEM, n, 3);
      const name = `${pick(ADJ, n, 1)} ${pick(FABRIC, n, 2)} ${item.name} ${n}`;
      const colorCount = 2 + Math.floor(rnd(n, 4) * 3);
      const colors = [...new Set(Array.from({ length: colorCount }, (_, i) => pick(COLORS, n * 7 + i, 5)))];
      const sizes = SIZES.slice(Math.floor(rnd(n, 6) * 2), 4 + Math.floor(rnd(n, 7) * 3));
      const price = (499 + Math.floor(rnd(n, 8) * 60) * 50) * 100; // ₹499 – ₹3,449
      const mrp = Math.round((price * (1 + Math.floor(rnd(n, 9) * 4) / 10)) / 100) * 100;
      const product = await createProduct(
        {
          name,
          baseSku: code,
          description: `<p>${name} — performance test product.</p>`,
          shortDescription: `${name} in ${colors.length} colours.`,
          categoryId: pick(categories, n, 10),
          brandId: brands.length ? pick(brands, n, 11) : null,
          productType: item.type,
          status: rnd(n, 12) < 0.95 ? "ACTIVE" : "DRAFT",
          taxClassId: taxClass?.id ?? null,
          hsnCode: item.hsn,
          minStockLevel: 3,
          weightGrams: 400,
          tags: ["bulk", item.type.toLowerCase()],
          isFeatured: false,
          options: [
            { name: "Color", values: colors },
            { name: "Size", values: sizes },
          ],
          variants: colors.flatMap((color) =>
            sizes.map((size) => ({
              sku: `${code}-${color.slice(0, 3).toUpperCase()}-${size}`,
              options: { Color: color, Size: size },
              mrp,
              sellingPrice: price,
              costPrice: Math.round(price * 0.45),
              status: "ACTIVE" as const,
            })),
          ),
        } satisfies ProductInput,
        systemContext,
      );
      for (const v of product.variants) variantIds.push(v.id);
      created++;
      if (created % 100 === 0) {
        const rate = created / ((Date.now() - started) / 1000);
        console.log(`  ${created}/${target} products (${rate.toFixed(1)}/s)`);
      }
    };

    console.log(`creating ${target} products from ${`BULK-${String(start).padStart(6, "0")}`} (concurrency ${concurrency})`);
    for (let n = start; n < start + target; n += concurrency) {
      const batch = Array.from({ length: Math.min(concurrency, start + target - n) }, (_, i) => build(n + i));
      await Promise.all(batch);
    }

    console.log(`adding opening stock for ${variantIds.length} variants in ${warehouse.code}`);
    for (let i = 0; i < variantIds.length; i += 500) {
      const items = variantIds.slice(i, i + 500).map((variantId, j) => ({
        variantId,
        mode: "set" as const,
        quantity: Math.floor(rnd(i + j, 13) * 40),
        bucket: "ON_HAND" as const,
      }));
      await adjustStock({ warehouseId: warehouse.id, reason: "OPENING_STOCK", notes: "Bulk performance data", items }, systemContext);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    const total = await prisma.product.count();
    console.log(`✔ ${created} products / ${variantIds.length} variants in ${seconds}s — catalogue now has ${total} products`);
  } finally {
    await Promise.allSettled([prisma.$disconnect(), closeRedis(), closeQueues()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
