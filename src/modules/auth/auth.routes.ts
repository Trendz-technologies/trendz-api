import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ok, created } from "../../common/utils/http";
import { authenticate } from "../../common/middleware/authenticate";
import { rateLimit } from "../../common/middleware/rate-limit";
import { unauthenticated } from "../../common/errors/app-error";
import { logger } from "../../config/logger";
import * as auth from "./auth.service";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
} from "./auth.schemas";
import { revokeAllSessions, revokeSession, rotateSession, type IssuedTokens } from "./sessions";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "./tokens";
import { prisma } from "../../database/prisma";
import { sha256 } from "../../common/utils/crypto";

export const authRouter = Router();

type LoginHook = (req: Request, res: Response, userId: string) => Promise<void>;
const loginHooks: LoginHook[] = [];
/** Lets other modules react to sign-in (e.g. merging the guest cart). */
export const onLogin = (hook: LoginHook) => loginHooks.push(hook);

const meta = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.get("user-agent") ?? null });

/**
 * Browsers get httpOnly cookies only. Native clients (mobile app, POS device)
 * opt in with `X-Client: native` and receive tokens in the body to use as
 * `Authorization: Bearer` (they are not exposed to CSRF).
 */
async function respondWithSession(req: Request, res: Response, tokens: IssuedTokens, body: object, status = 200) {
  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
  for (const hook of loginHooks) {
    await hook(req, res, tokens.userId).catch((err: unknown) => logger.warn({ err }, "login hook failed"));
  }
  const native = req.get("x-client") === "native";
  const payload = native ? { ...body, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : body;
  return status === 201 ? created(res, payload) : ok(res, payload);
}

const limits = {
  login: rateLimit({ name: "login-ip", points: 20, durationSeconds: 15 * 60, message: "Too many sign-in attempts from this network. Try again later." }),
  register: rateLimit({ name: "register-ip", points: 10, durationSeconds: 3600 }),
  otp: rateLimit({ name: "otp-ip", points: 20, durationSeconds: 3600 }),
  otpVerify: rateLimit({ name: "otp-verify-ip", points: 30, durationSeconds: 15 * 60 }),
  reset: rateLimit({ name: "reset-ip", points: 10, durationSeconds: 3600 }),
  refresh: rateLimit({ name: "refresh-ip", points: 60, durationSeconds: 60 }),
};

authRouter.get("/csrf", (_req, res) => ok(res, { csrfToken: res.locals.csrfToken as string }));

authRouter.post("/register", limits.register, async (req, res) => {
  const input = registerSchema.parse(req.body);
  const result = await auth.register(input, meta(req));
  await respondWithSession(req, res, result, { user: result.user }, 201);
});

authRouter.post("/login", limits.login, async (req, res) => {
  const { identifier, password } = loginSchema.parse(req.body);
  const result = await auth.login(identifier, password, meta(req));
  await respondWithSession(req, res, result, { user: result.user });
});

// Codes by SMS confirm the mobile number of the account that is signed in. Nobody signs in with one.
authRouter.post("/otp", limits.otp, async (req, res) => {
  const { phone } = otpRequestSchema.parse(req.body);
  if (!req.auth) throw unauthenticated();
  ok(res, await auth.requestOtp(phone));
});

authRouter.post("/otp/verify", limits.otpVerify, async (req, res) => {
  const { phone, code } = otpVerifySchema.parse(req.body);
  if (!req.auth) throw unauthenticated();
  await auth.verifyPhoneForUser(req.auth.userId, phone, code);
  ok(res, { user: await auth.publicUser(req.auth.userId, req.auth.sessionId) });
});

authRouter.post("/refresh", limits.refresh, async (req, res) => {
  const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
  // Native clients send the token in the body; browsers rely on the httpOnly cookie.
  const token = body.refreshToken ?? (req.cookies?.[REFRESH_COOKIE] as string | undefined);
  if (!token) throw unauthenticated("Session expired. Please sign in again.");
  try {
    const tokens = await rotateSession(token, meta(req));
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    const native = req.get("x-client") === "native";
    ok(res, native ? { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } : { refreshed: true });
  } catch (err) {
    if ((err as { code?: string }).code !== "TOKEN_ROTATED") clearAuthCookies(res);
    throw err;
  }
});

authRouter.post("/logout", async (req, res) => {
  // Logout works even with an expired access token, via the refresh cookie.
  const refresh = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (req.auth?.sessionId) await revokeSession(req.auth.sessionId, "logout");
  else if (refresh) {
    const s = await prisma.userSession.findUnique({ where: { refreshTokenHash: sha256(refresh) }, select: { id: true } });
    if (s) await revokeSession(s.id, "logout");
  }
  clearAuthCookies(res);
  ok(res, { loggedOut: true });
});

authRouter.post("/logout-all", authenticate, async (req, res) => {
  await revokeAllSessions(prisma, req.auth!.userId, "logout all");
  clearAuthCookies(res);
  ok(res, { loggedOut: true });
});

authRouter.get("/me", authenticate, async (req, res) => {
  ok(res, { user: await auth.publicUser(req.auth!.userId, req.auth!.sessionId) });
});

authRouter.post("/verify-email/request", authenticate, limits.reset, async (req, res) => {
  await auth.requestEmailVerification(req.auth!.userId);
  ok(res, { sent: true });
});

authRouter.post("/verify-email/confirm", limits.reset, async (req, res) => {
  const { token } = tokenSchema.parse(req.body);
  await auth.confirmEmail(token);
  ok(res, { verified: true });
});

authRouter.post("/password/forgot", limits.reset, async (req, res) => {
  const { email } = forgotPasswordSchema.parse(req.body);
  await auth.forgotPassword(email);
  ok(res, { message: "If an account exists for this email, a reset link has been sent." });
});

authRouter.post("/password/reset", limits.reset, async (req, res) => {
  const { token, password } = resetPasswordSchema.parse(req.body);
  await auth.resetPassword(token, password);
  clearAuthCookies(res);
  ok(res, { reset: true });
});

authRouter.post("/password/change", authenticate, limits.reset, async (req, res) => {
  const input = changePasswordSchema.parse(req.body);
  await auth.changePassword(req.auth!.userId, req.auth!.sessionId, input);
  ok(res, { changed: true });
});
