import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requireAnyPermission, requirePermission } from "../../common/guards/permissions";
import { created, ok, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as codes from "./codes.service";
import { buildLabelsPdf, labelsSchema } from "./labels.service";
import { scanLookup, scanSchema } from "./scan.service";

/** /api/codes */
export const codesRouter = Router();
codesRouter.use(authenticate, requireStaff);

codesRouter.post("/bulk-generate", requirePermission("codes.manage"), async (req, res) => {
  ok(res, await codes.bulkGenerate(codes.bulkGenerateSchema.parse(req.body), auditContext(req)));
});

codesRouter.post("/labels", requirePermission("products.read"), async (req, res) => {
  const pdf = await buildLabelsPdf(labelsSchema.parse(req.body));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="labels-${Date.now()}.pdf"`);
  res.send(pdf);
});

codesRouter.patch("/:id", requirePermission("codes.manage"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status } = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).parse(req.body);
  ok(res, await codes.setCodeStatus(id, status, auditContext(req)));
});

codesRouter.post("/:id/regenerate", requirePermission("codes.manage"), async (req, res) => {
  created(res, await codes.regenerateCode(uuidParam.parse(req.params).id, auditContext(req)));
});

codesRouter.get("/:id/image", requirePermission("products.read"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { format, download } = z
    .object({ format: z.enum(["png", "svg"]).default("png"), download: z.enum(["1", "0"]).optional() })
    .parse(req.query);
  const code = await codes.getCode(id);
  const name = `${code.sku}-${code.codeType.toLowerCase()}.${format}`;
  res.setHeader("Content-Disposition", `${download === "1" ? "attachment" : "inline"}; filename="${name}"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  if (format === "svg") {
    res.type("image/svg+xml").send(await codes.renderCodeSvg(code));
  } else {
    res.type("image/png").send(await codes.renderCodePng(code, 4));
  }
});

/** /api/variants/:variantId/codes */
export const variantCodesRouter = Router();
variantCodesRouter.use(authenticate, requireStaff);
variantCodesRouter.post("/:variantId/codes", requirePermission("codes.manage"), async (req, res) => {
  const { variantId } = z.object({ variantId: z.uuid() }).parse(req.params);
  created(res, await codes.addCode(variantId, codes.createCodeSchema.parse(req.body), auditContext(req)));
});

/** Mounted on /api/products ahead of the product routes. */
export const scanRouter = Router();
scanRouter.use("/code", authenticate, requireStaff);
scanRouter.use("/scan", authenticate, requireStaff);

scanRouter.get("/code/:code", requireAnyPermission("pos.use", "inventory.read", "returns.manage"), async (req, res) => {
  const { code } = z.object({ code: z.string().min(1).max(500) }).parse(req.params);
  const { warehouseId } = z.object({ warehouseId: z.uuid() }).parse(req.query);
  ok(res, await scanLookup(code, warehouseId));
});

scanRouter.post("/scan", requireAnyPermission("pos.use", "inventory.read", "returns.manage"), async (req, res) => {
  const { code, warehouseId } = scanSchema.parse(req.body);
  ok(res, await scanLookup(code, warehouseId));
});
