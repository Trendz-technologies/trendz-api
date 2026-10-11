import type { Job } from "bullmq";
import type { QueueName } from "./queues";

export type JobHandler = (job: Job) => Promise<unknown>;

const handlers = new Map<QueueName, Map<string, JobHandler>>();

/** Modules register the job types they process. */
export function registerJob(queue: QueueName, name: string, handler: JobHandler) {
  let byName = handlers.get(queue);
  if (!byName) handlers.set(queue, (byName = new Map()));
  byName.set(name, handler);
}

export function handlersFor(queue: QueueName) {
  return handlers.get(queue) ?? new Map<string, JobHandler>();
}

export function registeredQueues(): QueueName[] {
  return [...handlers.keys()];
}

export interface Schedule {
  queue: QueueName;
  name: string;
  /** Repeat interval in ms, or a cron pattern. */
  every?: number;
  pattern?: string;
  data?: object;
}

export const schedules: Schedule[] = [];
export const registerSchedule = (s: Schedule) => schedules.push(s);
