import { Router } from "express";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requireAnyPermission, requirePermission } from "../../common/guards/permissions";
import { created, ok, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import { deleteTaxClass, saveTaxClass, taxClasses, taxClassSchema } from "./tax.service";

export const taxRouter = Router();
taxRouter.use(authenticate, requireStaff);

taxRouter.get("/", requireAnyPermission("settings.read", "products.read"), async (_req, res) => ok(res, await taxClasses()));

taxRouter.post("/", requirePermission("settings.write"), async (req, res) => {
  created(res, await saveTaxClass(null, taxClassSchema.parse(req.body), auditContext(req)));
});

taxRouter.put("/:id", requirePermission("settings.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await saveTaxClass(id, taxClassSchema.parse(req.body), auditContext(req)));
});

taxRouter.delete("/:id", requirePermission("settings.write"), async (req, res) => {
  await deleteTaxClass(uuidParam.parse(req.params).id, auditContext(req));
  ok(res, { deleted: true });
});
