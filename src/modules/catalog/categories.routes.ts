import { Router } from "express";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { created, ok, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as categories from "./categories.service";

export const categoriesRouter = Router();
categoriesRouter.use(authenticate, requireStaff);

categoriesRouter.get("/", requirePermission("categories.read"), async (_req, res) => ok(res, await categories.adminTree()));

categoriesRouter.put("/reorder", requirePermission("categories.write"), async (req, res) => {
  await categories.reorderCategories(categories.reorderSchema.parse(req.body), auditContext(req));
  ok(res, { reordered: true });
});

categoriesRouter.get("/:id", requirePermission("categories.read"), async (req, res) => {
  ok(res, await categories.getCategory(uuidParam.parse(req.params).id));
});

categoriesRouter.post("/", requirePermission("categories.write"), async (req, res) => {
  created(res, await categories.createCategory(categories.categorySchema.parse(req.body), auditContext(req)));
});

categoriesRouter.put("/:id", requirePermission("categories.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await categories.updateCategory(id, categories.categorySchema.parse(req.body), auditContext(req)));
});

categoriesRouter.delete("/:id", requirePermission("categories.write"), async (req, res) => {
  await categories.deleteCategory(uuidParam.parse(req.params).id, auditContext(req));
  ok(res, { deleted: true });
});
