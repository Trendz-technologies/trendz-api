import type { RequestHandler } from "express";
import { AppError } from "../errors/app-error";
import { randomToken, safeEqual } from "../utils/crypto";
import { CSRF_COOKIE, setCsrfCookie } from "../../modules/auth/tokens";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths authenticated by signature instead of cookies. */
const EXEMPT_PATHS = ["/api/payments/webhook", "/api/shipping/webhook"];

/**
 * Double-submit CSRF protection for cookie-authenticated browsers.
 * - Every response ensures a `csrf_token` cookie exists.
 * - Unsafe requests must echo it in the `X-CSRF-Token` header.
 * Requests using `Authorization: Bearer` (mobile / server clients) carry no
 * ambient credentials and are not subject to CSRF.
 */
export const csrfProtection: RequestHandler = (req, res, next) => {
  let cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (!cookieToken) {
    cookieToken = randomToken(24);
    setCsrfCookie(res, cookieToken);
  }
  res.locals.csrfToken = cookieToken;

  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.some((p) => req.path === p)) return next();
  if (req.headers.authorization?.startsWith("Bearer ")) return next();

  const headerToken = req.get("x-csrf-token");
  if (!headerToken || !req.cookies?.[CSRF_COOKIE] || !safeEqual(headerToken, cookieToken)) {
    throw new AppError(403, "CSRF_INVALID", "Security token missing or invalid. Refresh the page and try again.");
  }
  next();
};
