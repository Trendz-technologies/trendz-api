import { logger } from "./config/logger";
import { prisma } from "./database/prisma";
import { closeRedis } from "./database/redis";
import { closeQueues } from "./jobs/queues";
import { startWorkers } from "./jobs/runner";

async function main() {
  const stopWorkers = await startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down worker");
    await stopWorkers();
    await Promise.allSettled([closeQueues(), prisma.$disconnect(), closeRedis()]);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
