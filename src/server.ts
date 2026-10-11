import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./database/prisma";
import { closeRedis } from "./database/redis";
import { closeQueues } from "./jobs/queues";
import { startWorkers } from "./jobs/runner";

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Keep-alive slightly above the proxy's upstream timeout to avoid 502s on reuse.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;

// A host that runs one process (Render's free plan has no background worker)
// does the worker's job here. The API keeps serving if the jobs cannot start,
// and tries again every minute until they do.
const JOBS_RETRY_MS = 60_000;
let stopWorkers: (() => Promise<void>) | undefined;
async function startJobs() {
  try {
    const stop = await startWorkers();
    if (shuttingDown) await stop();
    else stopWorkers = stop;
  } catch (err) {
    logger.error({ err }, "background jobs failed to start in the API process; trying again in a minute");
    if (!shuttingDown) setTimeout(() => void startJobs(), JOBS_RETRY_MS).unref();
  }
}
if (env.RUN_WORKER_IN_API) void startJobs();

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down API");
  const workersStopped = stopWorkers?.();
  server.close(async () => {
    await workersStopped;
    await Promise.allSettled([prisma.$disconnect(), closeRedis(), closeQueues()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandled promise rejection"));
