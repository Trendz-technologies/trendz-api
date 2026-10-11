import { Prisma, PrismaClient } from "@prisma/client";
import { isProduction } from "../config/env";
import { logger } from "../config/logger";

export const prisma = new PrismaClient({
  log: [
    { level: "warn", emit: "event" },
    { level: "error", emit: "event" },
  ],
});

prisma.$on("warn", (e) => logger.warn({ prisma: e.message }, "prisma warning"));
prisma.$on("error", (e) => logger.error({ prisma: e.message }, "prisma error"));

/** A Prisma client bound to an interactive transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the root client or a transaction client. */
export type Db = PrismaClient | Tx;

/**
 * Runs `fn` inside a transaction. Money/stock operations use READ COMMITTED
 * plus explicit row locks (SELECT ... FOR UPDATE), which is PostgreSQL's
 * recommended pattern for this kind of workload.
 */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
  return prisma.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: opts?.timeoutMs ?? (isProduction ? 15_000 : 30_000),
    maxWait: 10_000,
  });
}
