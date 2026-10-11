import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../database/prisma";
import { cached } from "../../database/redis";
import { AppError, forbidden, unauthenticated } from "../errors/app-error";
import { loadPrincipal } from "../../modules/auth/principal";
import { ACCESS_COOKIE, verifyAccessToken } from "../../modules/auth/tokens";

const SESSION_TTL_SECONDS = 60;
export const sessionCacheKey = (sid: string) => `auth:session:${sid}`;

function readToken(req: Request): { token: string; method: "cookie" | "bearer" } | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7).trim(), method: "bearer" };
  const cookie = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  return cookie ? { token: cookie, method: "cookie" } : null;
}

async function sessionIsActive(sessionId: string, userId: string): Promise<boolean> {
  const state = await cached(sessionCacheKey(sessionId), SESSION_TTL_SECONDS, async () => {
    const s = await prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, revokedAt: true, expiresAt: true },
    });
    return s && !s.revokedAt && s.expiresAt > new Date() ? s.userId : "revoked";
  });
  return state === userId;
}

async function resolve(req: Request, required: boolean): Promise<void> {
  const found = readToken(req);
  if (!found) {
    if (required) throw unauthenticated();
    return;
  }
  let claims;
  try {
    claims = verifyAccessToken(found.token);
  } catch (err) {
    if (!required) return;
    if (err instanceof jwt.TokenExpiredError) throw unauthenticated("Session expired", "TOKEN_EXPIRED");
    throw unauthenticated("Invalid session");
  }
  if (!(await sessionIsActive(claims.sid, claims.sub))) {
    if (required) throw unauthenticated("Session has been signed out");
    return;
  }
  const principal = await loadPrincipal(claims.sub, claims.sid);
  if (principal.status !== "ACTIVE") throw forbidden("This account is disabled", "ACCOUNT_DISABLED");
  req.auth = principal;
  req.authMethod = found.method;
}

/** Requires a valid session. */
export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) await resolve(req, true);
  next();
};

/** Attaches the user when a valid session is present; never rejects. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    await resolve(req, false);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  next();
};

/** Staff-only area (admin panel / POS). */
export const requireStaff: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthenticated();
  if (!req.auth.isStaff) throw forbidden();
  next();
};
