import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { emailSchema, phoneSchema } from "../auth/auth.schemas";
import { hashPassword, passwordSchema } from "../auth/password";
import { invalidatePrincipal, type Principal } from "../auth/principal";
import { revokeAllSessions } from "../auth/sessions";
import { audit, type AuditContext } from "../audit/audit.service";
import { CUSTOMER_ROLE, SUPER_ADMIN } from "../rbac/permissions";

export const userListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["staff", "customer", "all"]).default("staff"),
  role: z.string().max(50).optional(),
  status: z.enum(["ACTIVE", "DISABLED", "LOCKED"]).optional(),
});

export const createStaffSchema = z.object({
  email: emailSchema,
  phone: phoneSchema.optional(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional().default(""),
  password: passwordSchema,
  roleCodes: z.array(z.string().min(2).max(50)).min(1),
  defaultWarehouseId: z.uuid().nullable().optional(),
});

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).nullable().optional(),
  phone: phoneSchema.nullable().optional(),
  defaultWarehouseId: z.uuid().nullable().optional(),
});

export const setRolesSchema = z.object({ roleCodes: z.array(z.string().min(2).max(50)) });
export const setStatusSchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });

const userSelect = {
  id: true,
  email: true,
  phone: true,
  status: true,
  isStaff: true,
  lastLoginAt: true,
  createdAt: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  defaultWarehouseId: true,
  defaultWarehouse: { select: { id: true, code: true, name: true } },
  profile: { select: { firstName: true, lastName: true } },
  roles: { select: { role: { select: { code: true, name: true } } } },
} satisfies Prisma.UserSelect;

function shape(u: Prisma.UserGetPayload<{ select: typeof userSelect }>) {
  const { roles, ...rest } = u;
  return { ...rest, roles: roles.map((r) => r.role) };
}

export async function listUsers(query: z.infer<typeof userListQuery>, page: Pagination) {
  const where: Prisma.UserWhereInput = {
    isStaff: query.type === "all" ? undefined : query.type === "staff",
    status: query.status,
    roles: query.role ? { some: { role: { code: query.role } } } : undefined,
    OR: query.q
      ? [
          { email: { contains: query.q, mode: "insensitive" } },
          { phone: { contains: query.q } },
          { profile: { firstName: { contains: query.q, mode: "insensitive" } } },
          { profile: { lastName: { contains: query.q, mode: "insensitive" } } },
        ]
      : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: "desc" }, ...pageArgs(page) }),
    prisma.user.count({ where }),
  ]);
  return { items: items.map(shape), meta: pageMeta(page, total) };
}

export async function getUser(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!u) throw notFound("User");
  return shape(u);
}

async function resolveRoles(codes: string[], actor: Principal) {
  const unique = [...new Set(codes)];
  if (unique.includes(SUPER_ADMIN) && !actor.roles.includes(SUPER_ADMIN)) {
    throw forbidden("Only a super admin can grant the super admin role");
  }
  const roles = await prisma.role.findMany({ where: { code: { in: unique } }, select: { id: true, code: true } });
  if (roles.length !== unique.length) {
    const missing = unique.filter((c) => !roles.some((r) => r.code === c));
    throw badRequest(`Unknown role(s): ${missing.join(", ")}`);
  }
  return roles;
}

async function assertCanManage(targetId: string, actor: Principal) {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { roles: { select: { role: { select: { code: true } } } } } });
  if (!target) throw notFound("User");
  const targetIsSuper = target.roles.some((r) => r.role.code === SUPER_ADMIN);
  if (targetIsSuper && !actor.roles.includes(SUPER_ADMIN)) throw forbidden("Only a super admin can modify a super admin");
}

export async function createStaff(input: z.infer<typeof createStaffSchema>, actor: Principal, ctx: AuditContext) {
  const roles = await resolveRoles(input.roleCodes, actor);
  if (roles.some((r) => r.code === CUSTOMER_ROLE)) throw badRequest("Staff users cannot have the CUSTOMER role");
  const exists = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, ...(input.phone ? [{ phone: input.phone }] : [])] },
    select: { id: true },
  });
  if (exists) throw conflict("A user with this email or phone already exists");
  const passwordHash = await hashPassword(input.password);

  const user = await withTransaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: input.email,
        phone: input.phone ?? null,
        passwordHash,
        isStaff: true,
        emailVerifiedAt: new Date(),
        defaultWarehouseId: input.defaultWarehouseId ?? null,
        profile: { create: { firstName: input.firstName, lastName: input.lastName || null } },
        roles: { create: roles.map((r) => ({ roleId: r.id, assignedById: actor.userId })) },
      },
      select: { id: true },
    });
    await audit(tx, ctx, { action: "user.create", entityType: "user", entityId: u.id, newValue: { email: input.email, roles: input.roleCodes } });
    return u;
  });
  return getUser(user.id);
}

export async function updateUser(id: string, input: z.infer<typeof updateUserSchema>, actor: Principal, ctx: AuditContext) {
  await assertCanManage(id, actor);
  const before = await getUser(id);
  await withTransaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        phone: input.phone,
        defaultWarehouseId: input.defaultWarehouseId,
        profile:
          input.firstName !== undefined || input.lastName !== undefined
            ? { upsert: { create: { firstName: input.firstName, lastName: input.lastName ?? null }, update: { firstName: input.firstName, lastName: input.lastName } } }
            : undefined,
      },
    });
    await audit(tx, ctx, { action: "user.update", entityType: "user", entityId: id, oldValue: before, newValue: input });
  });
  await invalidatePrincipal(id);
  return getUser(id);
}

export async function setRoles(id: string, codes: string[], actor: Principal, ctx: AuditContext) {
  await assertCanManage(id, actor);
  const roles = await resolveRoles(codes, actor);
  const before = await getUser(id);
  const removingSuper = before.roles.some((r) => r.code === SUPER_ADMIN) && !codes.includes(SUPER_ADMIN);
  if (removingSuper) {
    const supers = await prisma.userRole.count({ where: { role: { code: SUPER_ADMIN }, user: { status: "ACTIVE" } } });
    if (supers <= 1) throw badRequest("At least one active super admin must remain");
  }
  const isStaff = roles.some((r) => r.code !== CUSTOMER_ROLE);
  await withTransaction(async (tx) => {
    await tx.userRole.deleteMany({ where: { userId: id } });
    await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id, assignedById: actor.userId })) });
    await tx.user.update({ where: { id }, data: { isStaff } });
    await audit(tx, ctx, {
      action: "user.roles.update",
      entityType: "user",
      entityId: id,
      oldValue: before.roles.map((r) => r.code),
      newValue: codes,
    });
  });
  await invalidatePrincipal(id);
  return getUser(id);
}

export async function setStatus(id: string, status: "ACTIVE" | "DISABLED", actor: Principal, ctx: AuditContext) {
  if (id === actor.userId) throw badRequest("You cannot change your own account status");
  await assertCanManage(id, actor);
  await withTransaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
    await tx.user.update({ where: { id }, data: { status, lockedUntil: null, failedLoginCount: 0 } });
    if (status === "DISABLED") await revokeAllSessions(tx, id, "account disabled");
    await audit(tx, ctx, { action: "user.status", entityType: "user", entityId: id, oldValue: before.status, newValue: status });
  });
  await invalidatePrincipal(id);
  return getUser(id);
}
