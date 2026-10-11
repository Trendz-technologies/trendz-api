import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as returns from "./returns.service";

const statusEnum = z.enum(["REQUESTED", "APPROVED", "REJECTED", "PICKUP_SCHEDULED", "RECEIVED", "REFUNDED", "CLOSED", "CANCELLED"]);

/** /api/returns (staff) */
export const returnsRouter = Router();
returnsRouter.use(authenticate, requireStaff);

returnsRouter.get("/", requirePermission("returns.read"), async (req, res) => {
  const q = z.object({ status: statusEnum.optional(), orderId: z.uuid().optional() }).parse(req.query);
  const { items, meta } = await returns.listReturns(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

returnsRouter.post("/", requirePermission("returns.manage"), async (req, res) => {
  created(res, await returns.createStaffReturn(returns.staffReturnSchema.parse(req.body), auditContext(req)));
});

returnsRouter.post("/scan", requirePermission("returns.manage"), async (req, res) => {
  const { code, orderNumber } = z.object({ code: z.string().min(1).max(500), orderNumber: z.string().max(40).optional() }).parse(req.body);
  ok(res, await returns.scanForReturn(code, orderNumber));
});

returnsRouter.get("/:id", requirePermission("returns.read"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, { ...(await returns.getReturn(id)), refundableAmount: await returns.returnRefundableAmount(id) });
});

returnsRouter.post("/:id/approve", requirePermission("returns.manage"), async (req, res) => {
  const { notes } = z.object({ notes: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
  ok(res, await returns.approveReturn(uuidParam.parse(req.params).id, notes, auditContext(req)));
});

returnsRouter.post("/:id/reject", requirePermission("returns.manage"), async (req, res) => {
  const { notes } = z.object({ notes: z.string().trim().min(3).max(1000) }).parse(req.body);
  ok(res, await returns.rejectReturn(uuidParam.parse(req.params).id, notes, auditContext(req)));
});

returnsRouter.post("/:id/receive", requirePermission("returns.manage"), async (req, res) => {
  ok(res, await returns.receiveReturn(uuidParam.parse(req.params).id, returns.receiveSchema.parse(req.body), auditContext(req)));
});

returnsRouter.post("/:id/refund", requirePermission("returns.manage"), requirePermission("refunds.create"), idempotent("returns.refund"), async (req, res) => {
  const { amount } = z.object({ amount: z.number().int().positive().optional() }).parse(req.body ?? {});
  ok(res, await returns.refundReturn(uuidParam.parse(req.params).id, amount, auditContext(req)));
});

returnsRouter.post("/:id/close", requirePermission("returns.manage"), async (req, res) => {
  ok(res, await returns.closeReturn(uuidParam.parse(req.params).id, auditContext(req)));
});

/** /api/account/returns (customer) */
export const accountReturnsRouter = Router();
accountReturnsRouter.use(authenticate);

accountReturnsRouter.get("/returns", async (req, res) => {
  const { items, meta } = await returns.listReturns({ userId: req.auth!.userId }, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

accountReturnsRouter.post("/returns", async (req, res) => {
  created(res, await returns.createCustomerReturn(req.auth!.userId, returns.customerReturnSchema.parse(req.body), auditContext(req)));
});

accountReturnsRouter.get("/returns/:returnNumber", async (req, res) => {
  const { returnNumber } = z.object({ returnNumber: z.string().max(40) }).parse(req.params);
  ok(res, await returns.getCustomerReturn(req.auth!.userId, decodeURIComponent(returnNumber)));
});
