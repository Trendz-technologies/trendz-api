import { Router } from "express";
import { z } from "zod";
import { isProduction } from "../../config/env";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { rateLimit } from "../../common/middleware/rate-limit";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { isIndianPincode } from "../../common/utils/india";
import { badRequest } from "../../common/errors/app-error";
import { auditContext } from "../audit/audit.service";
import { getSetting } from "../settings/settings.service";
import * as shipping from "./shipping.service";

/** /api/shipping — public rate check + provider webhook */
export const shippingRouter = Router();

shippingRouter.post("/rates", rateLimit({ name: "ship-rates", points: 30, durationSeconds: 60 }), async (req, res) => {
  const { postalCode, weightGrams, value } = z
    .object({ postalCode: z.string().trim(), weightGrams: z.number().int().positive().max(100_000).default(500), value: z.number().int().min(0).default(0) })
    .parse(req.body);
  if (!isIndianPincode(postalCode)) throw badRequest("Enter a valid 6-digit PIN code");
  const settings = await getSetting("shipping");
  if (settings.mode === "FLAT") {
    return ok(res, { serviceable: true, amount: settings.flatRate, freeShippingThreshold: settings.freeShippingThreshold });
  }
  ok(res, { serviceable: true, amount: await shipping.shippingRateFor(postalCode, weightGrams, value), freeShippingThreshold: settings.freeShippingThreshold });
});

shippingRouter.post("/webhook", async (req, res) => {
  ok(res, await shipping.ingestShippingWebhook(req.get("x-api-key"), req.body));
});

/** /api/shipments — staff */
export const shipmentsRouter = Router();
shipmentsRouter.use(authenticate, requireStaff);

const statusEnum = z.enum(["NOT_REQUIRED", "PENDING", "CREATED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "FAILED", "RETURN_TO_ORIGIN", "RETURNED"]);

shipmentsRouter.get("/", requirePermission("shipping.read"), async (req, res) => {
  const q = z.object({ status: statusEnum.optional(), orderId: z.uuid().optional(), q: z.string().trim().max(50).optional() }).parse(req.query);
  const { items, meta } = await shipping.listShipments(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

shipmentsRouter.post("/", requirePermission("shipping.manage"), async (req, res) => {
  created(res, await shipping.createShipments(shipping.createShipmentSchema.parse(req.body), auditContext(req)));
});

shipmentsRouter.post("/manual", requirePermission("shipping.manage"), async (req, res) => {
  created(res, await shipping.createManualShipment(shipping.manualShipmentSchema.parse(req.body), auditContext(req)));
});

shipmentsRouter.get("/:id", requirePermission("shipping.read"), async (req, res) => ok(res, await shipping.getShipment(uuidParam.parse(req.params).id)));

shipmentsRouter.get("/:id/tracking", requirePermission("shipping.read"), async (req, res) => {
  ok(res, await shipping.refreshTracking(uuidParam.parse(req.params).id));
});

shipmentsRouter.post("/:id/cancel", requirePermission("shipping.manage"), async (req, res) => {
  ok(res, await shipping.cancelShipment(uuidParam.parse(req.params).id, auditContext(req)));
});

shipmentsRouter.get("/:id/label", requirePermission("shipping.read"), async (req, res) => {
  const label = await shipping.shipmentLabel(uuidParam.parse(req.params).id);
  if ("url" in label) return res.redirect(label.url);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=label.pdf");
  res.send(label.pdf);
});

if (!isProduction) {
  /** DEVELOPMENT ONLY: advance a mock parcel to its next status. */
  shipmentsRouter.post("/:id/simulate", requirePermission("shipping.manage"), async (req, res) => {
    ok(res, await shipping.simulateNextStatus(uuidParam.parse(req.params).id));
  });
}

/** /api/account/orders/:orderNumber/tracking — customer */
export const accountTrackingRouter = Router();
accountTrackingRouter.use(authenticate);
accountTrackingRouter.get("/orders/:orderNumber/tracking", async (req, res) => {
  const { orderNumber } = z.object({ orderNumber: z.string().max(40) }).parse(req.params);
  ok(res, await shipping.customerTracking(req.auth!.userId, orderNumber));
});
