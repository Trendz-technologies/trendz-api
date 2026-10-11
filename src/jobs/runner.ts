import { Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { getQueue, type QueueName } from "./queues";
import { handlersFor, registeredQueues, schedules } from "./registry";
import "./index";

const CONCURRENCY: Partial<Record<QueueName, number>> = {
  notifications: 10,
  media: 2, // image processing is CPU bound
  invoices: 4,
  webhooks: 5,
  shipping: 4,
  maintenance: 1,
};

/**
 * Starts one BullMQ worker per queue and registers the schedules. Used by the
 * worker process (src/worker.ts) and, when RUN_WORKER_IN_API=true, by the API
 * process (src/server.ts).
 *
 * Resolves to a function that lets running jobs finish and closes the workers.
 * It leaves the queues, Prisma, the app's Redis clients and the process to the
 * caller. All or nothing: if anything fails on the way, the workers that were
 * already started are closed again before the error is passed on.
 */
export async function startWorkers(): Promise<() => Promise<void>> {
  const workers: Worker[] = [];
  const connections: IORedis[] = [];
  const stop = async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    // A worker does not close a connection it was handed.
    for (const connection of connections) connection.disconnect();
  };

  try {
    for (const queue of registeredQueues()) {
      const handlers = handlersFor(queue);
      const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
      connections.push(connection);
      const worker = new Worker(
        queue,
        async (job) => {
          const handler = handlers.get(job.name);
          if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
          return handler(job);
        },
        { connection, concurrency: CONCURRENCY[queue] ?? 2 },
      );
      worker.on("failed", (job, err) =>
        logger.warn({ queue, job: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message }, "job failed"),
      );
      worker.on("error", (err) => logger.error({ queue, err: err.message }, "worker error"));
      workers.push(worker);
    }

    // Idempotent: re-running upserts the same schedulers.
    for (const s of schedules) {
      await getQueue(s.queue).upsertJobScheduler(
        `${s.queue}:${s.name}`,
        s.every ? { every: s.every } : { pattern: s.pattern! },
        { name: s.name, data: s.data ?? {} },
      );
    }
  } catch (err) {
    await stop();
    throw err;
  }

  logger.info({ queues: registeredQueues(), schedules: schedules.map((s) => s.name) }, "worker started");
  return stop;
}
