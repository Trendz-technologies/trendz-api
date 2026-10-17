import express, { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { badRequest } from "../../common/errors/app-error";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as images from "../media/images.service";
import { listCodesForProduct } from "../codes/codes.service";
import { buildTemplate, importProduct, importProductSchema, MAX_IMPORT_FILE_BYTES, previewImport } from "./product-import";
import { productInputSchema, productListQuery } from "./products.schemas";
import * as products from "./products.service";

export const productsRouter = Router();
productsRouter.use(authenticate, requireStaff);

const imageParams = z.object({ id: z.uuid(), imageId: z.uuid() });

// --- import from Excel (before "/:id", which would take "import" for an id) ---

productsRouter.get("/import/template", requirePermission("products.write"), async (_req, res) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="trendz-product-import.xlsx"');
  res.send(await buildTemplate());
});

// The workbook itself is the request body.
productsRouter.post("/import/preview", requirePermission("products.write"), express.raw({ type: () => true, limit: MAX_IMPORT_FILE_BYTES }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest("Send the Excel file as the request body", "IMPORT_FILE_MISSING");
  ok(res, await previewImport(req.body));
});

productsRouter.post("/import/product", requirePermission("products.write"), async (req, res) => {
  ok(res, await importProduct(importProductSchema.parse(req.body), auditContext(req)));
});

productsRouter.get("/", requirePermission("products.read"), async (req, res) => {
  const { items, meta } = await products.listProducts(productListQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

productsRouter.post("/", requirePermission("products.write"), async (req, res) => {
  created(res, await products.createProduct(productInputSchema.parse(req.body), auditContext(req)));
});

productsRouter.get("/:id", requirePermission("products.read"), async (req, res) => {
  ok(res, await products.getProduct(uuidParam.parse(req.params).id));
});

productsRouter.put("/:id", requirePermission("products.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await products.updateProduct(id, productInputSchema.parse(req.body), auditContext(req), req.auth!.permissions));
});

productsRouter.delete("/:id", requirePermission("products.delete"), async (req, res) => {
  ok(res, await products.deleteProduct(uuidParam.parse(req.params).id, auditContext(req)));
});

productsRouter.get("/:id/codes", requirePermission("products.read"), async (req, res) => {
  ok(res, await listCodesForProduct(uuidParam.parse(req.params).id));
});

// --- images ---------------------------------------------------------------

productsRouter.post("/:id/images/upload-url", requirePermission("products.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  created(res, await images.requestUpload(id, images.uploadRequestSchema.parse(req.body), auditContext(req)));
});

productsRouter.put("/:id/images/order", requirePermission("products.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  await images.reorderImages(id, images.reorderSchema.parse(req.body).imageIds);
  ok(res, { reordered: true });
});

productsRouter.post("/:id/images/:imageId/complete", requirePermission("products.write"), async (req, res) => {
  const { id, imageId } = imageParams.parse(req.params);
  ok(res, await images.completeUpload(id, imageId));
});

productsRouter.post("/:id/images/:imageId/replace", requirePermission("products.write"), async (req, res) => {
  const { id, imageId } = imageParams.parse(req.params);
  ok(res, await images.requestReplace(id, imageId, images.uploadRequestSchema.parse(req.body), auditContext(req)));
});

productsRouter.patch("/:id/images/:imageId", requirePermission("products.write"), async (req, res) => {
  const { id, imageId } = imageParams.parse(req.params);
  ok(res, await images.updateImage(id, imageId, images.imageUpdateSchema.parse(req.body)));
});

productsRouter.delete("/:id/images/:imageId", requirePermission("products.write"), async (req, res) => {
  const { id, imageId } = imageParams.parse(req.params);
  await images.deleteImage(id, imageId, auditContext(req));
  ok(res, { deleted: true });
});
