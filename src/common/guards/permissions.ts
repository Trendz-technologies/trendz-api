import type { RequestHandler } from "express";
import { forbidden, unauthenticated } from "../errors/app-error";
import type { PermissionCode } from "../../modules/rbac/permissions";

/** Requires every listed permission. Use after `authenticate`. */
export function requirePermission(...codes: PermissionCode[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    const missing = codes.filter((c) => !req.auth!.permissions.includes(c));
    if (missing.length) throw forbidden();
    next();
  };
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...codes: PermissionCode[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (!codes.some((c) => req.auth!.permissions.includes(c))) throw forbidden();
    next();
  };
}

export function can(permissions: readonly string[] | undefined, code: PermissionCode): boolean {
  return !!permissions?.includes(code);
}
