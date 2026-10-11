import { prisma } from "../../database/prisma";
import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";

const DAY = 24 * 3600_000;

/** Removes expired security artefacts. Business records are never deleted here. */
registerJob(QUEUE_NAMES.maintenance, "cleanup.auth", async () => {
  const now = Date.now();
  const [sessions, otps, tokens, keys, attempts] = await prisma.$transaction([
    prisma.userSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date(now - 7 * DAY) } }, { revokedAt: { lt: new Date(now - 30 * DAY) } }] },
    }),
    prisma.otpCode.deleteMany({ where: { createdAt: { lt: new Date(now - DAY) } } }),
    prisma.verificationToken.deleteMany({ where: { expiresAt: { lt: new Date(now - 7 * DAY) } } }),
    prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }),
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(now - 90 * DAY) } } }),
  ]);
  return { sessions: sessions.count, otps: otps.count, tokens: tokens.count, idempotencyKeys: keys.count, loginAttempts: attempts.count };
});
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "cleanup.auth", pattern: "15 3 * * *" }); // 03:15 daily
