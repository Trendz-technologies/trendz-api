import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { ok, paginationQuery } from "../../common/utils/http";
import { listAuditLogs } from "./audit.service";

export const auditRouter = Router();
auditRouter.use(authenticate, requireStaff, requirePermission("audit.read"));

const filterSchema = z.object({
  userId: z.uuid().optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditRouter.get("/", async (req, res) => {
  const { items, meta } = await listAuditLogs(filterSchema.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});
