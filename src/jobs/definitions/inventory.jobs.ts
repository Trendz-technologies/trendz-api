import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";
import { sendLowStockAlerts } from "../../modules/inventory/inventory.service";

/** Real-time check after stock decreases (queued by sales). */
registerJob(QUEUE_NAMES.maintenance, "inventory.low-stock-check", async (job) => sendLowStockAlerts((job.data as { variantIds: string[] }).variantIds));

/** Daily digest of everything at or below its threshold. 03:30 UTC = 09:00 IST. */
registerJob(QUEUE_NAMES.maintenance, "inventory.low-stock-digest", () => sendLowStockAlerts());
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "inventory.low-stock-digest", pattern: "30 3 * * *" });
