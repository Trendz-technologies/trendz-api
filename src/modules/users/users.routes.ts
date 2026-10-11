import { Router } from "express";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as users from "./users.service";

export const usersRouter = Router();
usersRouter.use(authenticate, requireStaff);

usersRouter.get("/", requirePermission("users.read"), async (req, res) => {
  const query = users.userListQuery.parse(req.query);
  const { items, meta } = await users.listUsers(query, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

usersRouter.post("/", requirePermission("users.write", "users.roles"), async (req, res) => {
  const input = users.createStaffSchema.parse(req.body);
  created(res, await users.createStaff(input, req.auth!, auditContext(req)));
});

usersRouter.get("/:id", requirePermission("users.read"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await users.getUser(id));
});

usersRouter.put("/:id", requirePermission("users.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = users.updateUserSchema.parse(req.body);
  ok(res, await users.updateUser(id, input, req.auth!, auditContext(req)));
});

usersRouter.put("/:id/roles", requirePermission("users.roles"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { roleCodes } = users.setRolesSchema.parse(req.body);
  ok(res, await users.setRoles(id, roleCodes, req.auth!, auditContext(req)));
});

usersRouter.post("/:id/status", requirePermission("users.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status } = users.setStatusSchema.parse(req.body);
  ok(res, await users.setStatus(id, status, req.auth!, auditContext(req)));
});
