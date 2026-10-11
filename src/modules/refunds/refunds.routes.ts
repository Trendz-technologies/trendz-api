import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as refunds from "./refunds.service";

export const refundsRouter = Router();
refundsRouter.use(authenticate, requireStaff);

refundsRouter.get("/", requirePermission("refunds.read"), async (req, res) => {
  const q = z.object({ status: z.enum(["PENDING", "PROCESSING", "PROCESSED", "FAILED"]).optional(), orderId: z.uuid().optional() }).parse(req.query);
  const { items, meta } = await refunds.listRefunds(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

refundsRouter.post("/", requirePermission("refunds.create"), idempotent("refunds.create"), async (req, res) => {
  const input = refunds.refundSchema.parse(req.body);
  created(res, await refunds.createRefund(input, auditContext(req), `manual:${req.get("idempotency-key")}`));
});

refundsRouter.get("/:id", requirePermission("refunds.read"), async (req, res) => {
  ok(res, await refunds.getRefund(uuidParam.parse(req.params).id));
});

refundsRouter.post("/:id/retry", requirePermission("refunds.create"), async (req, res) => {
  ok(res, await refunds.retryRefund(uuidParam.parse(req.params).id, auditContext(req)));
});
