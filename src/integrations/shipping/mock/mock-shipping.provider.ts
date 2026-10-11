import { randomInt } from "node:crypto";
import { redis } from "../../../database/redis";
import type { CreateShipmentInput, CreatedShipment, RateQuote, ShippingService, Tracking, TrackingEvent } from "../shipping.types";

/**
 * DEVELOPMENT ONLY — refused in production by config/env.ts.
 * Issues fake AWBs and simulates a courier journey: each call to
 * `advance()` (admin "simulate next status" button) moves the parcel one step.
 */
const JOURNEY: { status: TrackingEvent["status"]; raw: string; location: string }[] = [
  { status: "PICKUP_SCHEDULED", raw: "Pickup Scheduled", location: "Warehouse" },
  { status: "PICKED_UP", raw: "Picked Up", location: "Warehouse" },
  { status: "IN_TRANSIT", raw: "In Transit", location: "Hub" },
  { status: "OUT_FOR_DELIVERY", raw: "Out For Delivery", location: "Delivery centre" },
  { status: "DELIVERED", raw: "Delivered", location: "Customer address" },
];

export class MockShippingProvider implements ShippingService {
  readonly name = "MOCK" as const;

  async getRates(input: { weightGrams: number }): Promise<RateQuote[]> {
    const slabs = Math.max(1, Math.ceil(input.weightGrams / 500));
    return [
      { courierId: "mock-surface", courierName: "Mock Surface", amount: 4000 + 2000 * (slabs - 1), estimatedDays: 5 },
      { courierId: "mock-air", courierName: "Mock Air", amount: 7000 + 3000 * (slabs - 1), estimatedDays: 2 },
    ];
  }

  async createShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
    const awb = `MOCK${Date.now().toString().slice(-8)}${randomInt(10, 99)}`;
    await redis.set(`mockship:${awb}`, "0", "EX", 30 * 86_400);
    return {
      providerOrderId: `MO-${input.reference}`,
      providerShipmentId: `MS-${awb}`,
      awb,
      courierName: "Mock Surface",
      courierId: "mock-surface",
      trackingUrl: null,
      labelUrl: null,
      status: "PICKUP_SCHEDULED",
      shippingCost: 4000,
      estimatedDeliveryAt: new Date(Date.now() + 5 * 86_400_000),
    };
  }

  async cancelShipment() {}

  async getTracking(input: { awb: string | null }): Promise<Tracking> {
    const step = Number((input.awb && (await redis.get(`mockship:${input.awb}`))) ?? 0);
    const base = Date.now() - step * 3600_000;
    const events = JOURNEY.slice(0, step + 1).map((j, i) => ({ status: j.status, rawStatus: j.raw, location: j.location, description: j.raw, occurredAt: new Date(base + i * 3600_000) }));
    return { status: JOURNEY[step]!.status, events: events.reverse(), estimatedDeliveryAt: null };
  }

  async generateLabel() {
    return null; // labels are rendered locally for the mock provider
  }

  /** Moves a mock parcel to the next journey step. */
  async advance(awb: string) {
    const step = Math.min(JOURNEY.length - 1, Number((await redis.get(`mockship:${awb}`)) ?? 0) + 1);
    await redis.set(`mockship:${awb}`, String(step), "EX", 30 * 86_400);
    return JOURNEY[step]!.status;
  }
}
