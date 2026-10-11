import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";
import { syncActiveShipments } from "../../modules/shipping/shipping.service";

// Fallback for missed courier webhooks: poll parcels that are still moving.
registerJob(QUEUE_NAMES.shipping, "shipments.sync", () => syncActiveShipments());
registerSchedule({ queue: QUEUE_NAMES.shipping, name: "shipments.sync", every: 30 * 60_000 });
