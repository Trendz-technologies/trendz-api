import { z } from "zod";
import { richText } from "../../common/utils/html";
import { slugSchemaPattern } from "../../common/utils/slug";

export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,38}[A-Z0-9]$/, "SKU: 3-40 characters, letters, digits and hyphens");

/** Paise; ₹1 crore cap keeps every amount well inside a 32-bit integer. */
const money = z.number().int("Amounts are in paise (integers)").min(0).max(100_000_000);
const dimension = z.number().int().min(0).max(10_000_000).nullable().optional();

export const variantInputSchema = z.object({
  id: z.uuid().optional(),
  sku: skuSchema,
  options: z.record(z.string(), z.string().trim().min(1).max(40)).default({}),
  mrp: money,
  sellingPrice: money,
  costPrice: money.nullable().optional(),
  weightGrams: dimension,
  lengthMm: dimension,
  widthMm: dimension,
  heightMm: dimension,
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "DISCONTINUED"]).default("ACTIVE"),
  isDefault: z.boolean().optional(),
});

export const productInputSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    slug: z.string().trim().toLowerCase().regex(slugSchemaPattern, "Use lowercase letters, numbers and hyphens").max(100).optional(),
    baseSku: skuSchema,
    description: z.string().max(20_000).nullable().optional(),
    shortDescription: richText(500),
    categoryId: z.uuid(),
    brandId: z.uuid().nullable().optional(),
    productType: z.string().trim().max(60).nullable().optional(),
    status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED", "DISCONTINUED"]).default("DRAFT"),
    taxClassId: z.uuid().nullable().optional(),
    hsnCode: z.string().trim().regex(/^\d{4,8}$/, "HSN/SAC codes are 4-8 digits").nullable().optional(),
    minStockLevel: z.number().int().min(0).max(100_000).default(0),
    weightGrams: dimension,
    lengthMm: dimension,
    widthMm: dimension,
    heightMm: dimension,
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).default([]),
    isFeatured: z.boolean().default(false),
    seoTitle: z.string().trim().max(70).nullable().optional(),
    seoDescription: z.string().trim().max(170).nullable().optional(),
    seoKeywords: z.string().trim().max(300).nullable().optional(),
    options: z
      .array(z.object({ name: z.string().trim().min(1).max(30), values: z.array(z.string().trim().min(1).max(40)).min(1).max(50) }))
      .max(3)
      .default([]),
    variants: z.array(variantInputSchema).min(1).max(200),
  })
  .superRefine((p, ctx) => {
    const optionNames = p.options.map((o) => o.name.toLowerCase());
    if (new Set(optionNames).size !== optionNames.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Option names must be unique" });
    p.options.forEach((o, i) => {
      if (new Set(o.values.map((v) => v.toLowerCase())).size !== o.values.length) {
        ctx.addIssue({ code: "custom", path: ["options", i, "values"], message: `Duplicate values in ${o.name}` });
      }
    });

    if (p.options.length === 0 && p.variants.length > 1) {
      ctx.addIssue({ code: "custom", path: ["variants"], message: "Add options (e.g. Size, Color) to create more than one variant" });
    }

    const skus = new Set<string>();
    const combos = new Set<string>();
    p.variants.forEach((v, i) => {
      if (v.sellingPrice > v.mrp) ctx.addIssue({ code: "custom", path: ["variants", i, "sellingPrice"], message: "Selling price cannot exceed MRP" });
      if (skus.has(v.sku)) ctx.addIssue({ code: "custom", path: ["variants", i, "sku"], message: `Duplicate SKU ${v.sku}` });
      skus.add(v.sku);

      const keys = Object.keys(v.options);
      if (keys.length !== p.options.length || !p.options.every((o) => o.name in v.options)) {
        ctx.addIssue({ code: "custom", path: ["variants", i, "options"], message: `Choose a value for each option (${p.options.map((o) => o.name).join(", ")})` });
        return;
      }
      for (const o of p.options) {
        if (!o.values.includes(v.options[o.name]!)) {
          ctx.addIssue({ code: "custom", path: ["variants", i, "options", o.name], message: `"${v.options[o.name]}" is not a value of ${o.name}` });
        }
      }
      const combo = p.options.map((o) => v.options[o.name]).join("\u0000");
      if (combos.has(combo)) ctx.addIssue({ code: "custom", path: ["variants", i, "options"], message: "Two variants have the same option values" });
      combos.add(combo);
    });
    if (p.variants.filter((v) => v.isDefault).length > 1) {
      ctx.addIssue({ code: "custom", path: ["variants"], message: "Only one variant can be the default" });
    }
  });

export type ProductInput = z.infer<typeof productInputSchema>;
export type VariantInput = z.infer<typeof variantInputSchema>;

export const productListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED", "DISCONTINUED"]).optional(),
  stock: z.enum(["in", "low", "out"]).optional(),
  sort: z.enum(["newest", "oldest", "name", "price_asc", "price_desc", "updated"]).default("newest"),
});
