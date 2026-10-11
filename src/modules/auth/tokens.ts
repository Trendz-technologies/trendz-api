import type { CookieOptions, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { randomToken } from "../../common/utils/crypto";

const ISSUER = "trendz-api";
const AUDIENCE = "trendz";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";
export const CSRF_COOKIE = "csrf_token";

export interface AccessClaims {
  sub: string;
  sid: string;
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId, typ: "access" }, env.JWT_SECRET, {
    algorithm: "HS256",
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  });
}

/** Throws jwt.TokenExpiredError / JsonWebTokenError on invalid tokens. */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  }) as jwt.JwtPayload;
  if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new jwt.JsonWebTokenError("invalid token type");
  }
  return { sub: payload.sub, sid: payload.sid };
}

export const newRefreshToken = () => randomToken(48);
export const refreshTtlMs = () => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

function baseCookie(): CookieOptions {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    domain: env.COOKIE_DOMAIN,
    path: "/",
  };
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookie(),
    httpOnly: true,
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000,
  });
  // The refresh token is only ever sent to the auth endpoints.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    httpOnly: true,
    path: "/api/auth",
    maxAge: refreshTtlMs(),
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), httpOnly: true });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), httpOnly: true, path: "/api/auth" });
}

export function setCsrfCookie(res: Response, token: string) {
  // Readable by the web app's JavaScript (double-submit pattern).
  res.cookie(CSRF_COOKIE, token, { ...baseCookie(), httpOnly: false, maxAge: refreshTtlMs() });
}
