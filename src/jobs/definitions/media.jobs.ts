import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";
import { storage } from "../../integrations/object-storage";
import { markImageFailed, processImage, sweepImages } from "../../modules/media/images.service";

registerJob(QUEUE_NAMES.media, "image.process", async (job) => {
  const { imageId } = job.data as { imageId: string };
  try {
    await processImage(imageId);
  } catch (err) {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) await markImageFailed(imageId, (err as Error).message);
    throw err;
  }
});

registerJob(QUEUE_NAMES.media, "image.delete-objects", async (job) => {
  await storage().delete((job.data as { keys: string[] }).keys);
});

registerJob(QUEUE_NAMES.maintenance, "images.sweep", () => sweepImages());
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "images.sweep", every: 15 * 60_000 });
