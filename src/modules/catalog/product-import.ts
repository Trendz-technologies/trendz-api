import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { z } from "zod";
import { prisma } from "../../database/prisma";
import { badRequest, unprocessable } from "../../common/errors/app-error";
import { logger } from "../../config/logger";
import { storage } from "../../integrations/object-storage";
import { audit, type AuditContext } from "../audit/audit.service";
import { markImageFailed, MAX_IMAGES_PER_PRODUCT, processImage } from "../media/images.service";
import { downloadImage, prepareImage, RemoteImageError } from "../media/remote-image";
import { productInputSchema, skuSchema } from "./products.schemas";
import { createProduct, deleteProduct } from "./products.service";

/*
 * Adding products from an Excel sheet.
 *
 * One row per variant (a size / colour combination); rows with the same Base
 * SKU make one product, whose own columns are filled on its first row. The
 * Base SKU is the product's unique key: a product whose Base SKU is already in
 * the shop is skipped, so the same file can be imported again without making
 * copies, and only the new products are added.
 *
 * The import runs in two steps, so the admin can check the file first and
 * see the progress product by product:
 *   1. previewImport reads the sheet and answers which products are ready,
 *      which are already in the shop and which have problems (with row numbers);
 *   2. importProduct adds one ready product: it downloads its pictures first,
 *      and only creates the product when every picture could be used.
 */

export const IMPORT_SHEET = "Products";
const MAX_ROWS = 2000;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_DOWNLOADS_AT_ONCE = 4;
const IMAGE_PROCESSING_AT_ONCE = 3;

type ColumnKey =
  | "baseSku" | "name" | "category" | "brand" | "status" | "shortDescription" | "description" | "tags" | "hsnCode" | "taxClass" | "featured"
  | "size" | "color" | "variantSku" | "mrp" | "sellingPrice" | "costPrice" | "weightGrams" | "productImages" | "variantImages";

interface Column {
  key: ColumnKey;
  header: string;
  /** Other headings accepted for this column (compared after normalising, see headingKey). */
  aliases?: string[];
  required?: boolean;
  /** Product columns are read from the first row of a product; variant columns from every row. */
  level: "product" | "variant";
  width: number;
  help: string;
  text?: boolean;
  money?: boolean;
}

const COLUMNS: Column[] = [
  { key: "baseSku", header: "Base SKU *", aliases: ["style code"], required: true, level: "product", width: 16, text: true,
    help: "The product's unique code (style code). Rows with the same Base SKU are one product. A Base SKU that is already in the shop is skipped, so nothing is added twice." },
  { key: "name", header: "Product name *", aliases: ["name"], required: true, level: "product", width: 30, help: "The name shown in the shop (2 to 200 characters)." },
  { key: "category", header: "Category *", required: true, level: "product", width: 20, help: "Pick a category from the list. It must already exist in the admin under Catalog > Categories." },
  { key: "brand", header: "Brand", level: "product", width: 18, help: "Optional. Pick a brand from the list (Catalog > Brands)." },
  { key: "status", header: "Status", level: "product", width: 11, help: "Draft (hidden, the default) or Active (shown in the shop)." },
  { key: "shortDescription", header: "Short description", level: "product", width: 32, help: "Optional. One or two lines shown near the price (up to 500 characters)." },
  { key: "description", header: "Description", level: "product", width: 40, help: "Optional. Shown on the product page. Start a new paragraph with an empty line (Alt+Enter twice)." },
  { key: "tags", header: "Tags", level: "product", width: 20, help: "Optional. Words that help search, separated by commas, e.g. cotton, festive." },
  { key: "hsnCode", header: "HSN code", aliases: ["hsn", "hsn/sac code"], level: "product", width: 11, text: true, help: "Optional. 4 to 8 digits, printed on invoices." },
  { key: "taxClass", header: "Tax class", level: "product", width: 14, help: "Optional. Pick from the list; empty uses the shop's default tax class." },
  { key: "featured", header: "Featured", level: "product", width: 10, help: "Yes to show the product among the featured products. Empty means No." },
  { key: "size", header: "Size", level: "variant", width: 9, text: true, help: "The size of this row's variant, e.g. S, M, L, XL. Leave empty if the product has no sizes." },
  { key: "color", header: "Color", aliases: ["colour"], level: "variant", width: 12, help: "The colour of this row's variant, e.g. Pink. Leave empty if the product comes in one colour." },
  { key: "variantSku", header: "Variant SKU", aliases: ["sku"], level: "variant", width: 22, text: true, help: "Optional. Empty makes one from the Base SKU, size and colour, e.g. KUR-1001-M-PINK." },
  { key: "mrp", header: "MRP (₹) *", aliases: ["mrp"], required: true, level: "variant", width: 11, money: true, help: "The maximum retail price in rupees, including tax." },
  { key: "sellingPrice", header: "Selling price (₹) *", aliases: ["price", "sale price"], required: true, level: "variant", width: 13, money: true, help: "The price the customer pays, in rupees including tax. Not more than the MRP." },
  { key: "costPrice", header: "Cost price (₹)", aliases: ["cost"], level: "variant", width: 12, money: true, help: "Optional. What the variant costs you; never shown in the shop." },
  { key: "weightGrams", header: "Weight (g)", aliases: ["weight", "weight grams"], level: "variant", width: 10, help: "Optional. Packed weight in grams, used for shipping." },
  { key: "productImages", header: "Product image URLs", aliases: ["product images", "image urls", "images", "image url"], level: "product", width: 45,
    help: "Web addresses of photos of the whole product. Several: separate with a comma or put each on its own line (Alt+Enter). The first photo is the cover." },
  { key: "variantImages", header: "Variant image URLs", aliases: ["variant images", "variant image url"], level: "variant", width: 45,
    help: "Web addresses of photos of this row's size and colour. They are shown when a shopper picks that variant." },
];
const COLUMN = new Map(COLUMNS.map((c) => [c.key, c]));

/** "MRP (₹) *" → "mrp": headings are matched without case, units, stars or extra spaces. */
const headingKey = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[*:]/g, " ").replace(/\s+/g, " ").trim();
const HEADINGS = new Map<string, ColumnKey>();
for (const c of COLUMNS) for (const h of [c.header, ...(c.aliases ?? [])]) HEADINGS.set(headingKey(h), c.key);
const label = (key: ColumnKey) => COLUMN.get(key)!.header.replace(/\s*\*$/, "");
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE_ROWS = 1000;
const STATUS_CHOICES = ["Draft", "Active"];
const YES_NO = ["Yes", "No"];

async function referenceLists() {
  const [categories, brands, taxClasses] = await Promise.all([
    prisma.category.findMany({ orderBy: [{ path: "asc" }, { name: "asc" }], select: { id: true, name: true, slug: true, isActive: true } }),
    prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
    prisma.taxClass.findMany({ orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
  ]);
  return { categories, brands, taxClasses };
}

/** exceljs supports a range address here ("C2:C1001") but leaves `dataValidations` out of its typings. */
const validations = (ws: ExcelJS.Worksheet) => (ws as unknown as { dataValidations: { add(address: string, validation: ExcelJS.DataValidation): void } }).dataValidations;

const colLetter = (n: number) => {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

function styleHeading(row: ExcelJS.Row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F1A24" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
}

function addProductColumns(ws: ExcelJS.Worksheet) {
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.text ? { numFmt: "@" } : c.money ? { numFmt: "0.00" } : {} }));
  styleHeading(ws.getRow(1));
  COLUMNS.forEach((c, i) => (ws.getCell(1, i + 1).note = c.help));
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
}

/** The import workbook: an empty Products sheet with drop-down lists, a filled example and the instructions. */
export async function buildTemplate(): Promise<Buffer> {
  const { categories, brands, taxClasses } = await referenceLists();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Trendz";
  wb.created = new Date();

  const sheet = wb.addWorksheet(IMPORT_SHEET);
  addProductColumns(sheet);

  // Lists for the drop-downs (a separate sheet, so they can be longer than Excel's 255-character inline limit).
  const lists = wb.addWorksheet("Lists", { state: "hidden" });
  const categoryNames = categories.filter((c) => c.isActive).map((c) => c.name);
  const listColumns: [string, string[]][] = [
    ["Categories", categoryNames],
    ["Brands", brands.map((b) => b.name)],
    ["Tax classes", taxClasses.map((t) => t.code)],
    ["Status", STATUS_CHOICES],
    ["Yes / No", YES_NO],
  ];
  listColumns.forEach(([title, values], i) => {
    lists.getCell(1, i + 1).value = title;
    values.forEach((v, j) => (lists.getCell(j + 2, i + 1).value = v));
  });
  const dropDown = (key: ColumnKey, listIndex: number, message: string) => {
    const values = listColumns[listIndex]![1];
    if (!values.length) return;
    const col = colLetter(COLUMNS.findIndex((c) => c.key === key) + 1);
    const listCol = colLetter(listIndex + 1);
    validations(sheet).add(`${col}2:${col}${TEMPLATE_ROWS + 1}`, {
      type: "list",
      allowBlank: true,
      formulae: [`Lists!$${listCol}$2:$${listCol}$${values.length + 1}`],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: label(key),
      error: message,
    });
  };
  dropDown("category", 0, "Pick a category from the list. Add new categories in the admin first.");
  dropDown("brand", 1, "Pick a brand from the list, or leave the cell empty.");
  dropDown("taxClass", 2, "Pick a tax class from the list, or leave the cell empty.");
  dropDown("status", 3, "Choose Draft or Active.");
  dropDown("featured", 4, "Choose Yes or No.");

  // A filled example: two products, one with sizes and colours and one without.
  const example = wb.addWorksheet("Example");
  addProductColumns(example);
  const category = categoryNames[0] ?? "Kurti Sets";
  const kurti = { baseSku: "KUR-1001", name: "Floral Cotton Kurti", category, status: "Draft", shortDescription: "Breathable cotton kurti with a floral print.",
    description: "Soft, breathable cotton for every day.\n\nMachine wash cold.", tags: "cotton, floral, daily wear", hsnCode: "6204", featured: "No" };
  const img = (name: string) => `https://example.com/photos/${name}.jpg`;
  const rows: Partial<Record<ColumnKey, string | number>>[] = [
    { ...kurti, size: "S", color: "Pink", mrp: 1299, sellingPrice: 999, costPrice: 550, weightGrams: 250, productImages: `${img("kurti-front")}, ${img("kurti-back")}`, variantImages: img("kurti-pink") },
    { baseSku: "KUR-1001", size: "M", color: "Pink", mrp: 1299, sellingPrice: 999, costPrice: 550, weightGrams: 260 },
    { baseSku: "KUR-1001", size: "S", color: "Blue", mrp: 1299, sellingPrice: 999, costPrice: 550, weightGrams: 250, variantImages: img("kurti-blue") },
    { baseSku: "KUR-1001", size: "M", color: "Blue", mrp: 1299, sellingPrice: 999, costPrice: 550, weightGrams: 260 },
    { baseSku: "DUP-2001", name: "Silk Dupatta", category, status: "Draft", tags: "silk, festive", mrp: 899, sellingPrice: 749, weightGrams: 150, productImages: img("dupatta") },
  ];
  for (const r of rows) example.addRow(r);

  const help = wb.addWorksheet("How to fill");
  help.columns = [{ header: "Column", width: 22 }, { header: "Required", width: 10 }, { header: "What to enter", width: 100 }];
  styleHeading(help.getRow(1));
  const intro = [
    "Fill the Products sheet: one row per variant (size + colour). The Example sheet shows two finished products.",
    "Rows with the same Base SKU make one product. Fill the product's own columns (name, category, …) on its first row; on its other rows leave them empty.",
    "The Base SKU is the product's unique key: a Base SKU that is already in the shop is skipped, so importing the same file twice never adds a product twice.",
    "The same size and colour twice in one product is left out once if the rows are identical, and reported when they differ.",
    "Image URLs must be the address of the picture itself (usually ending in .jpg, .png or .webp). A Google Drive link works when the file is shared with 'Anyone with the link'.",
    "Pictures up to 15 MB are accepted; ones over 2 MB are made smaller. A product is only added when all of its pictures could be downloaded.",
    "Before anything is added, the admin shows which products are ready, which are already in the shop and which rows need fixing.",
  ];
  for (const line of intro) help.addRow(["", "", line]);
  help.addRow([]);
  for (const c of COLUMNS) help.addRow([label(c.key), c.required ? "Yes" : "", c.help]);
  help.eachRow((row, n) => n > 1 && (row.getCell(3).alignment = { wrapText: true, vertical: "top" }));

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Reading a sheet
// ---------------------------------------------------------------------------

interface SheetRow {
  row: number;
  v: Record<ColumnKey, string>;
}

function cellText(cell: ExcelJS.Cell, link: boolean): string {
  if (link && cell.hyperlink) return cell.hyperlink.trim();
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && "result" in v) return v.result == null ? "" : String(v.result instanceof Date ? v.result.toISOString() : v.result).trim();
  return (cell.text ?? "").replace(/\r\n?/g, "\n").trim();
}

async function readRows(file: Buffer): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs declares its own Buffer type; a Node Buffer is what it reads at run time.
    await wb.xlsx.load(file as unknown as ExcelJS.Buffer);
  } catch {
    throw badRequest("The file could not be read. Save it as an Excel workbook (.xlsx) and try again.", "IMPORT_FILE_UNREADABLE");
  }
  const ws = wb.getWorksheet(IMPORT_SHEET) ?? wb.worksheets.find((w) => w.state === "visible" && w.name !== "Example" && w.name !== "How to fill");
  if (!ws) throw badRequest(`The workbook has no "${IMPORT_SHEET}" sheet`, "IMPORT_NO_SHEET");

  const columns = new Map<number, ColumnKey>();
  ws.getRow(1).eachCell((cell, col) => {
    const key = HEADINGS.get(headingKey(cellText(cell, false)));
    if (key && ![...columns.values()].includes(key)) columns.set(col, key);
  });
  const missing = COLUMNS.filter((c) => c.required && ![...columns.values()].includes(c.key)).map((c) => label(c.key));
  if (missing.length) {
    throw badRequest(`The ${ws.name} sheet has no column for ${missing.join(", ")}. Start from the template, which has every column in its first row.`, "IMPORT_COLUMNS_MISSING");
  }

  const rows: SheetRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const v = Object.fromEntries(COLUMNS.map((c) => [c.key, ""])) as Record<ColumnKey, string>;
    for (const [col, key] of columns) v[key] = cellText(row.getCell(col), key === "productImages" || key === "variantImages");
    if (Object.values(v).every((x) => !x)) continue;
    if (rows.length >= MAX_ROWS) throw badRequest(`A file can have at most ${MAX_ROWS} rows. Split it into smaller files.`, "IMPORT_TOO_MANY_ROWS");
    rows.push({ row: r, v });
  }
  if (!rows.length) throw badRequest(`The ${ws.name} sheet has no rows to import`, "IMPORT_EMPTY");
  return rows;
}

// ---------------------------------------------------------------------------
// Turning rows into products
// ---------------------------------------------------------------------------

const same = (a: string, b: string) => a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();

function money(raw: string): number | null | undefined {
  const s = raw.replace(/₹|rs\.?|inr|,|\s/gi, "");
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

function wholeNumber(raw: string): number | null | undefined {
  const s = raw.replace(/,|\s|g$|grams?$/gi, "");
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Math.round(Number(s));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text from a cell as paragraphs: an empty line starts a new one, a single line break stays a line break. */
function paragraphs(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return t
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Addresses in a cell, separated by line breaks, spaces or commas (a comma inside an address is kept). */
const splitUrls = (text: string) =>
  text
    .split(/\s+|,(?=\s*https?:\/\/)/i)
    .map((u) => u.trim().replace(/,+$/, ""))
    .filter(Boolean);

const isWebAddress = (u: string) => {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && u.length <= 2000;
  } catch {
    return false;
  }
};

const skuPart = (v: string) =>
  v
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
/** BASESKU-SIZE-COLOR, as the admin suggests it. */
const variantSkuFor = (baseSku: string, values: string[]) =>
  [baseSku, ...values]
    .map(skuPart)
    .filter(Boolean)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");

export const importImageSchema = z.object({
  url: z.string().trim().max(2000).refine(isWebAddress, "Not a web address"),
  variantSku: skuSchema.nullable().optional(),
});

/** What the admin sends back for one product to add (POST /products/import/product). */
export const importProductSchema = z.object({
  product: productInputSchema,
  images: z.array(importImageSchema).max(MAX_IMAGES_PER_PRODUCT).default([]),
});
export type ImportProductInput = z.infer<typeof importProductSchema>;

type Lookups = Awaited<ReturnType<typeof referenceLists>>;

interface ReadyProduct {
  baseSku: string;
  name: string;
  rows: number[];
  category: string;
  options: string;
  variants: number;
  images: number;
  warnings: string[];
  /** The body for POST /products/import/product. */
  payload: { product: Record<string, unknown>; images: { url: string; variantSku: string | null }[] };
}

interface Problem {
  baseSku: string | null;
  name: string | null;
  rows: number[];
  errors: string[];
}

function findBy<T extends { name: string; slug?: string; code?: string }>(list: T[], raw: string): T | "ambiguous" | null {
  const byName = list.filter((x) => same(x.name, raw));
  if (byName.length === 1) return byName[0]!;
  const byKey = list.find((x) => (x.slug && same(x.slug, raw)) || (x.code && same(x.code, raw)));
  if (byKey) return byKey;
  return byName.length > 1 ? "ambiguous" : null;
}

function buildProduct(baseSku: string, rows: SheetRow[], lk: Lookups): { ready?: ReadyProduct; problem?: Problem } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rowNumbers = rows.map((r) => r.row);

  // Product columns: the first value given; a different value on a later row is a mistake.
  const pick = (key: ColumnKey) => {
    let value = "";
    let from = 0;
    for (const r of rows) {
      const v = r.v[key];
      if (!v) continue;
      if (!value) [value, from] = [v, r.row];
      else if (!same(v, value)) errors.push(`Row ${r.row}: ${label(key)} "${short(v)}" differs from "${short(value)}" on row ${from}. Fill it once, on the product's first row.`);
    }
    return value;
  };

  const name = pick("name");
  if (!name) errors.push(`Row ${rows[0]!.row}: ${label("name")} is empty`);
  else if (name.length < 2 || name.length > 200) errors.push(`Row ${rows[0]!.row}: ${label("name")} must be 2 to 200 characters`);

  const categoryText = pick("category");
  const category = categoryText ? findBy(lk.categories, categoryText) : null;
  if (!categoryText) errors.push(`Row ${rows[0]!.row}: ${label("category")} is empty`);
  else if (category === "ambiguous") errors.push(`Category "${short(categoryText)}" matches more than one category; use its slug instead`);
  else if (!category) errors.push(`Category "${short(categoryText)}" does not exist. Add it under Catalog > Categories first, or pick one from the list.`);

  const brandText = pick("brand");
  const brand = brandText ? findBy(lk.brands, brandText) : null;
  if (brandText && (!brand || brand === "ambiguous")) errors.push(`Brand "${short(brandText)}" does not exist. Add it under Catalog > Brands first, or leave the cell empty.`);

  const taxText = pick("taxClass");
  const taxClass = taxText ? findBy(lk.taxClasses, taxText) : null;
  if (taxText && (!taxClass || taxClass === "ambiguous")) errors.push(`Tax class "${short(taxText)}" does not exist. Use one of: ${lk.taxClasses.map((t) => t.code).join(", ")}`);

  const statusText = pick("status");
  const status = !statusText ? "DRAFT" : same(statusText, "active") ? "ACTIVE" : same(statusText, "draft") ? "DRAFT" : null;
  if (!status) errors.push(`${label("status")} "${short(statusText)}" must be Draft or Active`);

  const featuredText = pick("featured");
  const featured = !featuredText ? false : /^(yes|y|true|1)$/i.test(featuredText) ? true : /^(no|n|false|0)$/i.test(featuredText) ? false : null;
  if (featured === null) errors.push(`${label("featured")} "${short(featuredText)}" must be Yes or No`);

  const hsnCode = pick("hsnCode");
  if (hsnCode && !/^\d{4,8}$/.test(hsnCode)) errors.push(`${label("hsnCode")} "${short(hsnCode)}" must be 4 to 8 digits`);

  const tags = [...new Set(pick("tags").split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 30) errors.push("At most 30 tags");
  const longTag = tags.find((t) => t.length > 40);
  if (longTag) errors.push(`Tag "${short(longTag)}" is longer than 40 characters`);

  // Options: Size and Color, from the values the rows use (the first spelling of a value wins).
  const optionKeys = (["size", "color"] as const).filter((k) => rows.some((r) => r.v[k]));
  for (const k of optionKeys) {
    for (const r of rows) if (!r.v[k]) errors.push(`Row ${r.row}: ${label(k)} is empty, but other rows of ${baseSku} have one`);
  }
  const spelling = new Map<string, string>();
  const valueOf = (k: "size" | "color", raw: string) => {
    const id = `${k}\u0000${raw.toLowerCase()}`;
    if (!spelling.has(id)) spelling.set(id, raw);
    return spelling.get(id)!;
  };
  const tooLong = rows.flatMap((r) => optionKeys.filter((k) => r.v[k].length > 40).map((k) => `Row ${r.row}: ${label(k)} is longer than 40 characters`));
  errors.push(...tooLong);

  interface Variant { row: number; values: Partial<Record<"size" | "color", string>>; sku: string; mrp: number; sellingPrice: number; costPrice: number | null; weightGrams: number | null; images: string[] }
  const variants: Variant[] = [];
  const combos = new Map<string, { row: number; signature: string }>();
  for (const r of rows) {
    const values = Object.fromEntries(optionKeys.map((k) => [k, valueOf(k, r.v[k])])) as Variant["values"];
    const combo = optionKeys.map((k) => values[k]!.toLowerCase()).join("\u0000");
    const signature = JSON.stringify([r.v.variantSku, r.v.mrp, r.v.sellingPrice, r.v.costPrice, r.v.weightGrams, r.v.variantImages].map((x) => x.toLowerCase()));
    const seen = combos.get(combo);
    if (seen) {
      const what = optionKeys.length ? optionKeys.map((k) => values[k]).join(" / ") : "the product";
      if (seen.signature === signature) warnings.push(`Row ${r.row} repeats row ${seen.row} (${what}) and was left out`);
      else if (optionKeys.length) errors.push(`Rows ${seen.row} and ${r.row} are both ${what}. Each size and colour needs one row.`);
      else errors.push(`Rows ${seen.row} and ${r.row} are both for ${baseSku}, which has no Size or Color to tell them apart`);
      continue;
    }
    combos.set(combo, { row: r.row, signature });

    const mrp = money(r.v.mrp);
    const sellingPrice = money(r.v.sellingPrice);
    const costPrice = money(r.v.costPrice);
    const weightGrams = wholeNumber(r.v.weightGrams);
    for (const [key, value] of [["mrp", mrp], ["sellingPrice", sellingPrice]] as const) {
      if (value === null) errors.push(`Row ${r.row}: ${label(key)} is empty`);
      else if (value === undefined) errors.push(`Row ${r.row}: ${label(key)} "${short(r.v[key])}" is not an amount in rupees`);
      else if (value > 100_000_000) errors.push(`Row ${r.row}: ${label(key)} is more than ₹1 crore`);
    }
    if (costPrice === undefined) errors.push(`Row ${r.row}: ${label("costPrice")} "${short(r.v.costPrice)}" is not an amount in rupees`);
    if (weightGrams === undefined || (weightGrams ?? 0) > 10_000_000) errors.push(`Row ${r.row}: ${label("weightGrams")} "${short(r.v.weightGrams)}" is not a weight in grams`);
    if (typeof mrp === "number" && typeof sellingPrice === "number" && sellingPrice > mrp) errors.push(`Row ${r.row}: the selling price is more than the MRP`);

    const sku = (r.v.variantSku || variantSkuFor(baseSku, optionKeys.map((k) => values[k]!))).toUpperCase();
    if (!skuSchema.safeParse(sku).success) errors.push(`Row ${r.row}: variant SKU "${short(sku)}" must be 3 to 40 letters, digits and hyphens`);

    const images = splitUrls(r.v.variantImages);
    for (const u of images) if (!isWebAddress(u)) errors.push(`Row ${r.row}: "${short(u)}" in ${label("variantImages")} is not a web address`);
    variants.push({ row: r.row, values, sku, mrp: mrp ?? 0, sellingPrice: sellingPrice ?? 0, costPrice: costPrice ?? null, weightGrams: weightGrams ?? null, images });
  }
  const skus = new Map<string, number>();
  for (const v of variants) {
    if (skus.has(v.sku)) errors.push(`Rows ${skus.get(v.sku)} and ${v.row} have the same variant SKU ${v.sku}`);
    else skus.set(v.sku, v.row);
  }

  // Pictures: the product's own (from any of its rows), then each variant's; an address used twice is kept once.
  const images: { url: string; variantSku: string | null }[] = [];
  const seenUrls = new Set<string>();
  const addImage = (url: string, variantSku: string | null) => {
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    images.push({ url, variantSku });
  };
  for (const r of rows) {
    for (const u of splitUrls(r.v.productImages)) {
      if (!isWebAddress(u)) errors.push(`Row ${r.row}: "${short(u)}" in ${label("productImages")} is not a web address`);
      else addImage(u, null);
    }
  }
  for (const v of variants) for (const u of v.images) if (isWebAddress(u)) addImage(u, optionKeys.length ? v.sku : null);
  if (images.length > MAX_IMAGES_PER_PRODUCT) errors.push(`${images.length} pictures; a product can have at most ${MAX_IMAGES_PER_PRODUCT}`);
  if (!images.length) warnings.push("No pictures: add some in the admin before showing it in the shop");

  const optionNames = { size: "Size", color: "Color" } as const;
  const product = {
    name,
    baseSku,
    categoryId: category && category !== "ambiguous" ? category.id : "",
    brandId: brand && brand !== "ambiguous" ? brand.id : null,
    status: status ?? "DRAFT",
    taxClassId: taxClass && taxClass !== "ambiguous" ? taxClass.id : null,
    hsnCode: hsnCode || null,
    shortDescription: paragraphs(pick("shortDescription")),
    description: paragraphs(pick("description")),
    tags,
    isFeatured: featured ?? false,
    options: optionKeys.map((k) => ({ name: optionNames[k], values: [...new Set(variants.map((v) => v.values[k]!))] })),
    variants: variants.map((v, i) => ({
      sku: v.sku,
      options: Object.fromEntries(optionKeys.map((k) => [optionNames[k], v.values[k]!])),
      mrp: v.mrp,
      sellingPrice: v.sellingPrice,
      costPrice: v.costPrice,
      weightGrams: v.weightGrams,
      isDefault: i === 0,
    })),
  };

  // The API's own rules last, for anything not caught above (e.g. a long short description).
  if (!errors.length) {
    const check = productInputSchema.safeParse(product);
    if (!check.success) {
      for (const issue of check.error.issues) {
        const [head, index] = issue.path;
        const where = head === "variants" && typeof index === "number" ? `Row ${variants[index]?.row}: ` : "";
        errors.push(`${where}${issue.path.length ? `${String(issue.path.at(-1))}: ` : ""}${issue.message}`);
      }
    }
  }

  if (errors.length) return { problem: { baseSku, name: name || null, rows: rowNumbers, errors } };
  const summary = product.options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" · ");
  return {
    ready: {
      baseSku,
      name,
      rows: rowNumbers,
      category: category && category !== "ambiguous" ? category.name : "",
      options: summary,
      variants: variants.length,
      images: images.length,
      warnings,
      payload: { product, images },
    },
  };
}

export interface ImportPreview {
  /** Rows read from the sheet (empty rows are not counted). */
  rows: number;
  ready: ReadyProduct[];
  skipped: { baseSku: string; name: string; rows: number[]; reason: string }[];
  problems: Problem[];
}

/** Step 1: reads the sheet and sorts its products into ready, already in the shop, and with problems. */
export async function previewImport(file: Buffer): Promise<ImportPreview> {
  const rows = await readRows(file);
  const lookups = await referenceLists();

  const problems: Problem[] = [];
  const groups = new Map<string, SheetRow[]>();
  for (const r of rows) {
    const baseSku = r.v.baseSku.toUpperCase();
    if (!baseSku) {
      problems.push({ baseSku: null, name: r.v.name || null, rows: [r.row], errors: [`Row ${r.row}: ${label("baseSku")} is empty`] });
      continue;
    }
    if (!skuSchema.safeParse(baseSku).success) {
      problems.push({ baseSku, name: r.v.name || null, rows: [r.row], errors: [`Row ${r.row}: Base SKU "${short(baseSku)}" must be 3 to 40 letters, digits and hyphens`] });
      continue;
    }
    groups.set(baseSku, [...(groups.get(baseSku) ?? []), r]);
  }

  const built: ReadyProduct[] = [];
  for (const [baseSku, group] of groups) {
    const { ready, problem } = buildProduct(baseSku, group, lookups);
    if (problem) problems.push(problem);
    if (ready) built.push(ready);
  }

  // Against the shop: the Base SKU decides whether a product is already there.
  const existing = await prisma.product.findMany({ select: { name: true, baseSku: true } });
  const byBaseSku = new Map(existing.map((p) => [p.baseSku, p.name]));
  const variantSkus = built.flatMap((p) => (p.payload.product.variants as { sku: string }[]).map((v) => v.sku));
  const takenVariants = await prisma.productVariant.findMany({ where: { sku: { in: variantSkus } }, select: { sku: true, product: { select: { baseSku: true, name: true } } } });
  const takenBy = new Map(takenVariants.map((v) => [v.sku, v.product]));

  const ready: ReadyProduct[] = [];
  const skipped: ImportPreview["skipped"] = [];
  const fileSkus = new Map<string, string>();
  for (const p of built) {
    const already = byBaseSku.get(p.baseSku);
    if (already !== undefined) {
      skipped.push({ baseSku: p.baseSku, name: p.name, rows: p.rows, reason: `Already in the shop as "${already}"` });
      continue;
    }
    const errors: string[] = [];
    for (const v of p.payload.product.variants as { sku: string }[]) {
      const owner = takenBy.get(v.sku);
      if (owner) errors.push(`Variant SKU ${v.sku} is already used by "${owner.name}" (${owner.baseSku})`);
      const other = fileSkus.get(v.sku);
      if (other) errors.push(`Variant SKU ${v.sku} is also used by ${other} in this file`);
    }
    if (errors.length) {
      problems.push({ baseSku: p.baseSku, name: p.name, rows: p.rows, errors });
      continue;
    }
    for (const v of p.payload.product.variants as { sku: string }[]) fileSkus.set(v.sku, p.baseSku);
    const twin = existing.find((e) => same(e.name, p.name));
    if (twin) p.warnings.push(`A product named "${twin.name}" is already in the shop (${twin.baseSku}); this one has a new Base SKU, so it will be added too`);
    ready.push(p);
  }

  problems.sort((a, b) => (a.rows[0] ?? 0) - (b.rows[0] ?? 0));
  return { rows: rows.length, ready, skipped, problems };
}

// ---------------------------------------------------------------------------
// Adding one product
// ---------------------------------------------------------------------------

async function inParallel<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

export type ImportProductResult =
  | { status: "skipped"; reason: string }
  | { status: "created"; product: { id: string; name: string; slug: string; baseSku: string }; images: { added: number; failed: { url: string; error: string }[] } };

/** Step 2: adds one product with its pictures, unless its Base SKU is already in the shop. */
export async function importProduct(input: ImportProductInput, ctx: AuditContext): Promise<ImportProductResult> {
  const already = await prisma.product.findUnique({ where: { baseSku: input.product.baseSku }, select: { name: true } });
  if (already) return { status: "skipped", reason: `Already in the shop as "${already.name}"` };
  const skus = new Set(input.product.variants.map((v) => v.sku));
  const strange = input.images.find((i) => i.variantSku && !skus.has(i.variantSku));
  if (strange) throw badRequest(`Picture ${strange.url} is for variant ${strange.variantSku}, which this product does not have`);

  // Every picture first: the product is only added when all of them can be used.
  const downloads = await inParallel(input.images, IMAGE_DOWNLOADS_AT_ONCE, async (img, i) => {
    try {
      return { ok: true as const, file: await prepareImage(await downloadImage(img.url)) };
    } catch (err) {
      const reason = err instanceof RemoteImageError ? err.message : "The picture could not be downloaded";
      if (!(err instanceof RemoteImageError)) logger.warn({ err, url: img.url }, "product import: picture download failed");
      return { ok: false as const, error: `Picture ${i + 1} (${short(img.url, 80)}): ${reason}` };
    }
  });
  const failed = downloads.flatMap((d) => (d.ok ? [] : [d.error]));
  if (failed.length) {
    throw unprocessable(`${failed.length === 1 ? "A picture" : `${failed.length} pictures`} could not be used, so the product was not added. ${failed.join(" · ")}`, "IMPORT_IMAGE_FAILED");
  }
  const files = downloads.map((d) => (d.ok ? d.file : null)!);

  const product = await createProduct(input.product, ctx);
  const variantId = new Map(product.variants.map((v) => [v.sku, { id: v.id, title: v.title }]));
  const stored: string[] = [];
  let imageIds: string[] = [];
  try {
    const records = await inParallel(input.images, IMAGE_DOWNLOADS_AT_ONCE, async (img, i) => {
      const id = randomUUID();
      const objectKey = `uploads/products/${product.id}/${id}/${Date.now().toString(36)}`;
      await storage().put(objectKey, files[i]!.body, files[i]!.contentType);
      stored.push(objectKey);
      const variant = img.variantSku ? variantId.get(img.variantSku) : undefined;
      return {
        id,
        productId: product.id,
        variantId: variant?.id ?? null,
        objectKey,
        altText: (variant ? `${product.name} – ${variant.title}` : product.name).slice(0, 200),
        sortOrder: i,
        mimeType: files[i]!.contentType,
        bytes: files[i]!.body.length,
        status: "PROCESSING" as const,
      };
    });
    await prisma.productImage.createMany({ data: records });
    imageIds = records.map((r) => r.id);
  } catch (err) {
    // Storing the pictures failed: take the product out again, so a new import can add it whole.
    await storage().delete(stored).catch(() => {});
    await deleteProduct(product.id, ctx).catch((e: unknown) => logger.error({ err: e, productId: product.id }, "product import: could not remove a half-added product"));
    throw err;
  }
  await audit(prisma, ctx, { action: "product.import", entityType: "product", entityId: product.id, newValue: { baseSku: product.baseSku, images: input.images.map((i) => i.url) } });

  // The sizes are made here rather than by the worker, so the pictures are ready when the import finishes.
  const problems: { url: string; error: string }[] = [];
  await inParallel(imageIds, IMAGE_PROCESSING_AT_ONCE, async (id, i) => {
    try {
      await processImage(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markImageFailed(id, message);
      problems.push({ url: input.images[i]!.url, error: message });
    }
  });
  return {
    status: "created",
    product: { id: product.id, name: product.name, slug: product.slug, baseSku: product.baseSku },
    images: { added: imageIds.length - problems.length, failed: problems },
  };
}
