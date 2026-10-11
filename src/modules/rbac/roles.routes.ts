import { Router } from "express";
import { z } from "zod";
import { richText } from "../../common/utils/html";
import { prisma, withTransaction } from "../../database/prisma";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors/app-error";
import { created, ok, uuidParam } from "../../common/utils/http";
import { audit, auditContext } from "../audit/audit.service";
import { invalidateAllPrincipals } from "../auth/principal";
import { CUSTOMER_ROLE, SUPER_ADMIN } from "./permissions";

export const rolesRouter = Router();
export const permissionsRouter = Router();
rolesRouter.use(authenticate, requireStaff);
permissionsRouter.use(authenticate, requireStaff);

const roleSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,49}$/, "Use UPPER_SNAKE_CASE"),
  name: z.string().trim().min(2).max(80),
  description: richText(300),
  permissions: z.array(z.string()).default([]),
});

async function permissionIds(codes: string[]) {
  const perms = await prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  if (perms.length !== new Set(codes).size) {
    const unknown = codes.filter((c) => !perms.some((p) => p.code === c));
    throw badRequest(`Unknown permission(s): ${unknown.join(", ")}`);
  }
  return perms.map((p) => p.id);
}

async function roleView(id: string) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { permissions: { select: { permission: { select: { code: true } } } }, _count: { select: { users: true } } },
  });
  if (!role) throw notFound("Role");
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    userCount: role._count.users,
    permissions: role.code === SUPER_ADMIN ? ["*"] : role.permissions.map((p) => p.permission.code).sort(),
  };
}

permissionsRouter.get("/", requirePermission("roles.read"), async (_req, res) => {
  ok(res, await prisma.permission.findMany({ orderBy: [{ module: "asc" }, { code: "asc" }] }));
});

rolesRouter.get("/", requirePermission("roles.read"), async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { createdAt: "asc" }, select: { id: true } });
  ok(res, await Promise.all(roles.map((r) => roleView(r.id))));
});

rolesRouter.get("/:id", requirePermission("roles.read"), async (req, res) => {
  ok(res, await roleView(uuidParam.parse(req.params).id));
});

rolesRouter.post("/", requirePermission("roles.write"), async (req, res) => {
  const input = roleSchema.parse(req.body);
  if (await prisma.role.findUnique({ where: { code: input.code } })) throw conflict("A role with this code already exists");
  const ids = await permissionIds(input.permissions);
  const role = await withTransaction(async (tx) => {
    const r = await tx.role.create({
      data: { code: input.code, name: input.name, description: input.description ?? null, permissions: { create: ids.map((permissionId) => ({ permissionId })) } },
    });
    await audit(tx, auditContext(req), { action: "role.create", entityType: "role", entityId: r.id, newValue: input });
    return r;
  });
  created(res, await roleView(role.id));
});

rolesRouter.put("/:id", requirePermission("roles.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = roleSchema.omit({ code: true }).parse(req.body);
  const before = await roleView(id);
  if (before.code === SUPER_ADMIN) throw forbidden("The super admin role always has every permission");
  if (before.code === CUSTOMER_ROLE && input.permissions.length) throw badRequest("The customer role cannot hold admin permissions");
  const ids = await permissionIds(input.permissions);
  await withTransaction(async (tx) => {
    await tx.role.update({ where: { id }, data: { name: input.name, description: input.description ?? null } });
    await tx.rolePermission.deleteMany({ where: { roleId: id } });
    await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
    await audit(tx, auditContext(req), { action: "role.update", entityType: "role", entityId: id, oldValue: before, newValue: input });
  });
  await invalidateAllPrincipals();
  ok(res, await roleView(id));
});

rolesRouter.delete("/:id", requirePermission("roles.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const role = await roleView(id);
  if (role.isSystem) throw badRequest("System roles cannot be deleted");
  if (role.userCount > 0) throw conflict("Remove this role from all users before deleting it");
  await withTransaction(async (tx) => {
    await tx.role.delete({ where: { id } });
    await audit(tx, auditContext(req), { action: "role.delete", entityType: "role", entityId: id, oldValue: role });
  });
  ok(res, { deleted: true });
});
