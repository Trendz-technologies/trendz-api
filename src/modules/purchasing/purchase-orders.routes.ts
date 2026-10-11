import { Router } from "express";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as po from "./purchase-orders.service";

export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(authenticate, requireStaff);

purchaseOrdersRouter.get("/", requirePermission("purchases.read"), async (req, res) => {
  const { items, meta } = await po.listPurchaseOrders(po.poListQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

purchaseOrdersRouter.post("/", requirePermission("purchases.write"), async (req, res) => {
  created(res, await po.createPurchaseOrder(po.poSchema.parse(req.body), auditContext(req)));
});

purchaseOrdersRouter.get("/:id", requirePermission("purchases.read"), async (req, res) => {
  ok(res, await po.getPurchaseOrder(uuidParam.parse(req.params).id));
});

purchaseOrdersRouter.put("/:id", requirePermission("purchases.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await po.updatePurchaseOrder(id, po.poSchema.parse(req.body), auditContext(req)));
});

purchaseOrdersRouter.post("/:id/submit", requirePermission("purchases.write"), async (req, res) => {
  ok(res, await po.transitionPurchaseOrder(uuidParam.parse(req.params).id, "submit", auditContext(req)));
});

purchaseOrdersRouter.post("/:id/approve", requirePermission("purchases.approve"), async (req, res) => {
  ok(res, await po.transitionPurchaseOrder(uuidParam.parse(req.params).id, "approve", auditContext(req)));
});

purchaseOrdersRouter.post("/:id/cancel", requirePermission("purchases.approve"), async (req, res) => {
  ok(res, await po.transitionPurchaseOrder(uuidParam.parse(req.params).id, "cancel", auditContext(req)));
});

purchaseOrdersRouter.post("/:id/close", requirePermission("purchases.approve"), async (req, res) => {
  ok(res, await po.transitionPurchaseOrder(uuidParam.parse(req.params).id, "close", auditContext(req)));
});

// Receiving is idempotent: a double-submitted GRN form must not add stock twice.
purchaseOrdersRouter.post("/:id/receive", requirePermission("purchases.receive"), idempotent("po.receive"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await po.receiveGoods(id, po.receiveSchema.parse(req.body), auditContext(req)));
});
