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

// A host that runs one process (Render's free plan has no background worker)
// does the worker's job here. The API keeps serving if the jobs cannot start.
let stopWorkers: (() => Promise<void>) | undefined;
if (env.RUN_WORKER_IN_API) {
  startWorkers().then(
    (stop) => (stopWorkers = stop),
    (err) => logger.error({ err }, "background jobs failed to start in the API process"),
  );
}

let shuttingDown = false;
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
