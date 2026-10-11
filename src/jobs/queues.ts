import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../config/logger";

export const QUEUE_NAMES = {
  notifications: "notifications",
  media: "media",
  invoices: "invoices",
  webhooks: "webhooks",
  shipping: "shipping",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 5_000 }, // 5s, 10s, 20s, 40s, 80s
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

let connection: IORedis | null = null;
const queues = new Map<QueueName, Queue>();

export function bullConnection(): IORedis {
  connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: bullConnection(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, q);
  }
  return q;
}

/** Longest a request waits for a job to be queued. */
const ENQUEUE_WAIT_MS = 3000;

/**
 * Adds a job. `jobId` makes the add idempotent: adding the same id twice while
 * the first job is still retained is a no-op. Enqueue failures are logged and
 * swallowed — every job type has a database-backed sweeper that re-enqueues
 * work that was committed but never queued (transactional outbox).
 */
export async function enqueue<T extends object>(
  queue: QueueName,
  name: string,
  data: T,
  opts: JobsOptions & { jobId?: string } = {},
): Promise<void> {
  // Never let a struggling Redis hold up the request that queued the job: wait a
  // few seconds at most. The queue connection keeps the command and adds the job
  // as soon as Redis answers (and outbox sweepers re-queue anything missed).
  const added = getQueue(queue)
    .add(name, data, opts)
    .then(
      () => "added" as const,
      (err: unknown) => {
        logger.error({ err, queue, name, jobId: opts.jobId }, "failed to enqueue job");
        return "failed" as const;
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), ENQUEUE_WAIT_MS);
  });
  const outcome = await Promise.race([added, timeout]);
  clearTimeout(timer);
  if (outcome === "slow") logger.warn({ queue, name, jobId: opts.jobId }, "enqueue is slow; continuing without waiting (the job is added when Redis responds)");
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => undefined);
    connection = null;
  }
}
