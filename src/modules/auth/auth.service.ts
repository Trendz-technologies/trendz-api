import type { z } from "zod";
import { env } from "../../config/env";
import { prisma, withTransaction } from "../../database/prisma";
import { AppError, badRequest, conflict, forbidden, unauthenticated } from "../../common/errors/app-error";
import { hmacSha256Hex, randomDigits, randomToken, safeEqual, sha256 } from "../../common/utils/crypto";
import { isEmailLike, normalizePhone } from "../../common/utils/phone";
import { createLimiter } from "../../common/middleware/rate-limit";
import { audit } from "../audit/audit.service";
import { sendTransientEmail, sendTransientSms } from "../notifications/notifications.service";
import { CUSTOMER_ROLE } from "../rbac/permissions";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password";
import { invalidatePrincipal, loadPrincipal } from "./principal";
import { createSession, revokeAllSessions, type ClientMeta, type IssuedTokens } from "./sessions";
import type { changePasswordSchema, registerSchema } from "./auth.schemas";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MINUTES = 60;

// Per-identifier limits (IP limits are applied in the routes).
const loginIdentifierLimiter = createLimiter({ name: "login-id", points: 10, durationSeconds: 15 * 60, message: "Too many sign-in attempts. Try again in a few minutes." });
const otpCooldown = createLimiter({ name: "otp-cooldown", points: 1, durationSeconds: 30, message: "Please wait 30 seconds before requesting another code." });
const otpHourly = createLimiter({ name: "otp-hourly", points: 5, durationSeconds: 3600, message: "Too many codes requested for this number. Try again later." });
const forgotLimiter = createLimiter({ name: "forgot-email", points: 3, durationSeconds: 3600, message: "Too many reset requests. Try again later." });

export type AuthResult = IssuedTokens & { user: Awaited<ReturnType<typeof publicUser>> };

export async function publicUser(userId: string, sessionId: string | null = null) {
  const p = await loadPrincipal(userId, sessionId);
  return {
    id: p.userId,
    email: p.email,
    phone: p.phone,
    name: p.name,
    isStaff: p.isStaff,
    emailVerified: p.emailVerified,
    phoneVerified: p.phoneVerified,
    defaultWarehouseId: p.defaultWarehouseId,
    roles: p.roles,
    permissions: p.permissions,
  };
}

async function customerRoleId(): Promise<string> {
  const role = await prisma.role.findUnique({ where: { code: CUSTOMER_ROLE }, select: { id: true } });
  if (!role) throw new Error("CUSTOMER role missing — run the database seed");
  return role.id;
}

async function recordAttempt(identifier: string, userId: string | null, method: string, success: boolean, reason: string | null, meta: ClientMeta) {
  await prisma.loginAttempt.create({
    data: { identifier, userId, method, success, reason, ipAddress: meta.ipAddress, userAgent: meta.userAgent?.slice(0, 500) },
  });
}

// ---------------------------------------------------------------------------
// Registration & password login
// ---------------------------------------------------------------------------

export async function register(input: z.infer<typeof registerSchema>, meta: ClientMeta): Promise<AuthResult> {
  const [byEmail, byPhone] = await Promise.all([
    prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    input.phone ? prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } }) : null,
  ]);
  if (byEmail) throw conflict("An account with this email already exists. Sign in instead.", "EMAIL_TAKEN");
  if (byPhone) throw conflict("This mobile number is already linked to an account.", "PHONE_TAKEN");

  const passwordHash = await hashPassword(input.password);
  const roleId = await customerRoleId();
  const tokens = await withTransaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        phone: input.phone ?? null,
        passwordHash,
        profile: { create: { firstName: input.firstName, lastName: input.lastName || null, marketingOptIn: input.marketingOptIn } },
        roles: { create: { roleId } },
      },
      select: { id: true },
    });
    return createSession(tx, user.id, meta);
  });

  const user = await publicUser(tokens.userId, tokens.sessionId);
  await requestEmailVerification(user.id).catch(() => undefined);
  return { ...tokens, user };
}


export async function login(identifierRaw: string, password: string, meta: ClientMeta): Promise<AuthResult> {
  const identifier = isEmailLike(identifierRaw) ? identifierRaw.trim().toLowerCase() : normalizePhone(identifierRaw) ?? identifierRaw.trim();
  await loginIdentifierLimiter.consume(identifier);

  const user = await prisma.user.findFirst({
    where: isEmailLike(identifier) ? { email: identifier } : { phone: identifier },
    select: { id: true, passwordHash: true, status: true, lockedUntil: true, failedLoginCount: true, isStaff: true },
  });

  if (!user || !user.passwordHash) {
    await burnPasswordCheck(password);
    await recordAttempt(identifier, user?.id ?? null, "PASSWORD", false, user ? "no_password" : "unknown_user", meta);
    throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect email/mobile or password");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAttempt(identifier, user.id, "PASSWORD", false, "locked", meta);
    throw forbidden(`Too many failed attempts. Account locked until ${user.lockedUntil.toISOString()}.`, "ACCOUNT_LOCKED");
  }
  if (user.status !== "ACTIVE") {
    await recordAttempt(identifier, user.id, "PASSWORD", false, "disabled", meta);
    throw forbidden("This account is disabled. Contact support.", "ACCOUNT_DISABLED");
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined,
      },
    });
    await recordAttempt(identifier, user.id, "PASSWORD", false, "bad_password", meta);
    throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect email/mobile or password");
  }

  const tokens = await withTransaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    if (user.isStaff) {
      await audit(tx, { userId: user.id, ipAddress: meta.ipAddress, userAgent: meta.userAgent }, { action: "auth.login", entityType: "user", entityId: user.id });
    }
    return createSession(tx, user.id, meta);
  });
  await recordAttempt(identifier, user.id, "PASSWORD", true, null, meta);
  await loginIdentifierLimiter.reset(identifier);
  return { ...tokens, user: await publicUser(user.id, tokens.sessionId) };
}

// ---------------------------------------------------------------------------
// OTP (mobile): a code by SMS that confirms the mobile number of a signed-in
// account. It does not sign anyone in; signing in is by password.
// ---------------------------------------------------------------------------

const OTP_PURPOSE = "VERIFY_PHONE";
const otpHash = (phone: string, code: string) => hmacSha256Hex(env.OTP_SECRET, `${phone}:${OTP_PURPOSE}:${code}`);

export async function requestOtp(phone: string) {
  await otpCooldown.consume(`${phone}:${OTP_PURPOSE}`);
  await otpHourly.consume(phone);

  const code = randomDigits(6);
  await prisma.$transaction([
    // Only the newest code is valid.
    prisma.otpCode.updateMany({ where: { identifier: phone, purpose: OTP_PURPOSE, consumedAt: null }, data: { consumedAt: new Date() } }),
    prisma.otpCode.create({
      data: { identifier: phone, purpose: OTP_PURPOSE, codeHash: otpHash(phone, code), maxAttempts: OTP_MAX_ATTEMPTS, expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000) },
    }),
  ]);
  await sendTransientSms("OTP", phone, { otp: code, minutes: String(OTP_TTL_MINUTES) });
  return { sent: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
}

async function consumeOtp(phone: string, code: string) {
  const otp = await prisma.otpCode.findFirst({
    where: { identifier: phone, purpose: OTP_PURPOSE, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw badRequest("The code has expired. Request a new one.", "OTP_EXPIRED");
  if (otp.attempts >= otp.maxAttempts) throw badRequest("Too many incorrect attempts. Request a new code.", "OTP_EXPIRED");

  if (!safeEqual(otp.codeHash, otpHash(phone, code))) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw badRequest("Incorrect code", "OTP_INVALID");
  }
  // Conditional consume so a code can never be used twice concurrently.
  const consumed = await prisma.otpCode.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count === 0) throw badRequest("The code has already been used. Request a new one.", "OTP_EXPIRED");
}

export async function verifyPhoneForUser(userId: string, phone: string, code: string) {
  await consumeOtp(phone, code);
  const owner = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
  if (owner && owner.id !== userId) throw conflict("This mobile number is already linked to another account.", "PHONE_TAKEN");
  await prisma.user.update({ where: { id: userId }, data: { phone, phoneVerifiedAt: new Date() } });
  await invalidatePrincipal(userId);
}

// ---------------------------------------------------------------------------
// Email verification & password reset
// ---------------------------------------------------------------------------

async function issueToken(userId: string, type: "EMAIL_VERIFY" | "PASSWORD_RESET", ttlMs: number): Promise<string> {
  const token = randomToken(32);
  await prisma.$transaction([
    prisma.verificationToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.verificationToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } }),
  ]);
  return token;
}

async function useToken(token: string, type: "EMAIL_VERIFY" | "PASSWORD_RESET") {
  const row = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt <= new Date()) {
    throw badRequest("This link is invalid or has expired. Request a new one.", "TOKEN_INVALID");
  }
  const used = await prisma.verificationToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count === 0) throw badRequest("This link has already been used.", "TOKEN_INVALID");
  return row.userId;
}

export async function requestEmailVerification(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, profile: { select: { firstName: true } } } });
  if (!user?.email || user.emailVerifiedAt) return;
  const token = await issueToken(userId, "EMAIL_VERIFY", EMAIL_TOKEN_TTL_HOURS * 3600_000);
  await sendTransientEmail("auth.verify_email", user.email, {
    name: user.profile?.firstName,
    url: `${env.WEB_URL}/verify-email?token=${encodeURIComponent(token)}`,
  });
}

export async function confirmEmail(token: string) {
  const userId = await useToken(token, "EMAIL_VERIFY");
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await invalidatePrincipal(userId);
}

/** Always succeeds from the caller's point of view (no account enumeration). */
export async function forgotPassword(email: string) {
  await forgotLimiter.consume(email);
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, status: true, profile: { select: { firstName: true } } },
  });
  if (!user || user.status === "DISABLED") return;
  const token = await issueToken(user.id, "PASSWORD_RESET", RESET_TOKEN_TTL_MINUTES * 60_000);
  await sendTransientEmail("auth.password_reset", email, {
    name: user.profile?.firstName,
    url: `${env.WEB_URL}/reset-password?token=${encodeURIComponent(token)}`,
  });
}

export async function resetPassword(token: string, password: string) {
  const userId = await useToken(token, "PASSWORD_RESET");
  const passwordHash = await hashPassword(password);
  await withTransaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      // Proving control of the inbox also verifies the email address.
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() },
    });
    await revokeAllSessions(tx, userId, "password reset");
  });
  await invalidatePrincipal(userId);
}

export async function changePassword(userId: string, sessionId: string | null, input: z.infer<typeof changePasswordSchema>) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw unauthenticated();
  if (user.passwordHash && !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw badRequest("Current password is incorrect", "INVALID_CREDENTIALS");
  }
  const passwordHash = await hashPassword(input.newPassword);
  await withTransaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await revokeAllSessions(tx, userId, "password changed", sessionId ?? undefined);
  });
}
