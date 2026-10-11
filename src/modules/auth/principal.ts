import { prisma } from "../../database/prisma";
import { cached, invalidate, invalidatePattern } from "../../database/redis";
import { notFound } from "../../common/errors/app-error";
import { ALL_PERMISSIONS, SUPER_ADMIN } from "../rbac/permissions";

/** The authenticated identity attached to a request. Cached in Redis briefly. */
export interface Principal {
  userId: string;
  sessionId: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
  isStaff: boolean;
  status: "ACTIVE" | "DISABLED" | "LOCKED";
  emailVerified: boolean;
  phoneVerified: boolean;
  defaultWarehouseId: string | null;
  roles: string[];
  permissions: string[];
}

const PRINCIPAL_TTL_SECONDS = 60;
const principalKey = (userId: string) => `auth:principal:${userId}`;

export async function loadPrincipal(userId: string, sessionId: string | null): Promise<Principal> {
  const base = await cached(principalKey(userId), PRINCIPAL_TTL_SECONDS, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        isStaff: true,
        status: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        defaultWarehouseId: true,
        profile: { select: { firstName: true, lastName: true } },
        roles: {
          select: {
            role: {
              select: { code: true, permissions: { select: { permission: { select: { code: true } } } } },
            },
          },
        },
      },
    });
    if (!user) throw notFound("User");
    const roles = user.roles.map((r) => r.role.code);
    const permissions = roles.includes(SUPER_ADMIN)
      ? [...ALL_PERMISSIONS]
      : [...new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))];
    const name = [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" ") || null;
    return {
      userId: user.id,
      email: user.email,
      phone: user.phone,
      name,
      isStaff: user.isStaff,
      status: user.status,
      emailVerified: !!user.emailVerifiedAt,
      phoneVerified: !!user.phoneVerifiedAt,
      defaultWarehouseId: user.defaultWarehouseId,
      roles,
      permissions,
    };
  });
  return { ...base, sessionId };
}

export const hasPermission = (p: Principal, code: string) => p.permissions.includes(code);

/** Call after any change to a user's roles, status or profile. */
export function invalidatePrincipal(userId: string) {
  return invalidate(principalKey(userId));
}

/** Call after a role's permissions change (affects every user with the role). */
export function invalidateAllPrincipals() {
  return invalidatePattern("auth:principal:*");
}
