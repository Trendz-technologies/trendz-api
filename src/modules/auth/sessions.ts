import { prisma, type Db } from "../../database/prisma";
import { invalidate } from "../../database/redis";
import { sessionCacheKey } from "../../common/middleware/authenticate";
import { unauthenticated } from "../../common/errors/app-error";
import { sha256 } from "../../common/utils/crypto";
import { logger } from "../../config/logger";
import { newRefreshToken, refreshTtlMs, signAccessToken } from "./tokens";

export interface ClientMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
}

/** Window in which a just-rotated refresh token is tolerated (parallel tabs). */
const ROTATION_GRACE_MS = 60_000;

export async function createSession(db: Db, userId: string, meta: ClientMeta): Promise<IssuedTokens> {
  const refreshToken = newRefreshToken();
  const session = await db.userSession.create({
    data: {
      userId,
      refreshTokenHash: sha256(refreshToken),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent?.slice(0, 500),
      expiresAt: new Date(Date.now() + refreshTtlMs()),
    },
    select: { id: true },
  });
  return { accessToken: signAccessToken(userId, session.id), refreshToken, sessionId: session.id, userId };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token outside the
 * grace window means the token was copied — the whole session is revoked.
 */
export async function rotateSession(refreshToken: string, meta: ClientMeta): Promise<IssuedTokens> {
  const hash = sha256(refreshToken);
  const session = await prisma.userSession.findUnique({ where: { refreshTokenHash: hash } });

  if (!session) {
    const reused = await prisma.userSession.findFirst({ where: { previousTokenHash: hash } });
    if (reused && !reused.revokedAt) {
      if (Date.now() - reused.lastUsedAt.getTime() < ROTATION_GRACE_MS) {
        throw unauthenticated("Session was refreshed in another tab. Retry.", "TOKEN_ROTATED");
      }
      await revokeSession(reused.id, "refresh token reuse detected");
      logger.warn({ sessionId: reused.id, userId: reused.userId }, "refresh token reuse detected; session revoked");
    }
    throw unauthenticated("Session expired. Please sign in again.");
  }
  if (session.revokedAt || session.expiresAt <= new Date()) {
    throw unauthenticated("Session expired. Please sign in again.");
  }

  const next = newRefreshToken();
  // Conditional update: if two requests race with the same token only one wins.
  const updated = await prisma.userSession.updateMany({
    where: { id: session.id, refreshTokenHash: hash, revokedAt: null },
    data: {
      refreshTokenHash: sha256(next),
      previousTokenHash: hash,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + refreshTtlMs()),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent?.slice(0, 500),
    },
  });
  if (updated.count === 0) throw unauthenticated("Session was refreshed in another tab. Retry.", "TOKEN_ROTATED");

  return { accessToken: signAccessToken(session.userId, session.id), refreshToken: next, sessionId: session.id, userId: session.userId };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await prisma.userSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  await invalidate(sessionCacheKey(sessionId));
}

export async function revokeAllSessions(db: Db, userId: string, reason: string, exceptSessionId?: string): Promise<void> {
  const sessions = await db.userSession.findMany({
    where: { userId, revokedAt: null, id: exceptSessionId ? { not: exceptSessionId } : undefined },
    select: { id: true },
  });
  if (!sessions.length) return;
  await db.userSession.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await invalidate(...sessions.map((s) => sessionCacheKey(s.id)));
}

export async function listSessions(userId: string, currentSessionId: string | null) {
  const sessions = await prisma.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, ipAddress: true, userAgent: true, createdAt: true, lastUsedAt: true },
  });
  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}
