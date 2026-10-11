import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";
import {
  deliverNotification,
  deliverTransient,
  sweepPendingNotifications,
  type TransientEmailJob,
  type TransientSmsJob,
} from "../../modules/notifications/notifications.service";

registerJob(QUEUE_NAMES.notifications, "deliver", async (job) => {
  await deliverNotification((job.data as { notificationId: string }).notificationId);
});

registerJob(QUEUE_NAMES.notifications, "transient", async (job) => {
  await deliverTransient(job.data as TransientEmailJob | TransientSmsJob);
});

registerJob(QUEUE_NAMES.maintenance, "notifications.sweep", async () => ({ requeued: await sweepPendingNotifications() }));
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "notifications.sweep", every: 60_000 });
