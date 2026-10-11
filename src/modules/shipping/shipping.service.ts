import { z } from "zod";
import { Prisma, type ShipmentStatus } from "@prisma/client";
import { logger } from "../../config/logger";
import { courierEnabled, env } from "../../config/env";
import { prisma, withTransaction } from "../../database/prisma";
import { AppError, badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { safeEqual, sha256 } from "../../common/utils/crypto";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { createPdf, MM, renderPdf } from "../../common/pdf/pdf";
import { mockShipping, shippingService, type Tracking } from "../../integrations/shipping";
import { mapShipmentStatus } from "../../integrations/shipping/shipping.types";
import { audit, type AuditContext } from "../audit/audit.service";
import { renderCodePng } from "../codes/codes.service";
import { onlineWarehouses } from "../inventory/availability";
import { dispatchNotifications } from "../notifications/notifications.service";
import { changeStatus, TRANSITIONS } from "../orders/orders.service";
import { getSetting } from "../settings/settings.service";

const ACTIVE: ShipmentStatus[] = ["PENDING", "CREATED", "PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"];
const FINAL: ShipmentStatus[] = ["DELIVERED", "CANCELLED", "RETURNED"];

// ---------------------------------------------------------------------------
// Rates (checkout, when shipping.mode = PROVIDER_RATES)
// ---------------------------------------------------------------------------

export async function shippingRateFor(deliveryPostalCode: string, weightGrams: number, declaredValue: number): Promise<number> {
  const [warehouse] = await onlineWarehouses();
  if (!warehouse) throw new AppError(409, "NO_FULFILMENT_WAREHOUSE", "No warehouse is configured to fulfil online orders");
  const wh = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouse.id }, select: { postalCode: true } });
  const rates = await shippingService().getRates({ pickupPostalCode: wh.postalCode, deliveryPostalCode, weightGrams, declaredValue });
  if (!rates.length) throw new AppError(422, "NOT_SERVICEABLE", `Delivery is not available to PIN code ${deliveryPostalCode}`);
  return rates[0]!.amount;
}

export async function cartWeightGrams(lines: { variantId: string; quantity: number }[]) {
  const { defaultWeightGrams } = await getSetting("shipping");
  const variants = await prisma.productVariant.findMany({ where: { id: { in: lines.map((l) => l.variantId) } }, select: { id: true, weightGrams: true, product: { select: { weightGrams: true } } } });
  return lines.reduce((s, l) => {
    const v = variants.find((x) => x.id === l.variantId);
    return s + (v?.weightGrams ?? v?.product.weightGrams ?? defaultWeightGrams) * l.quantity;
  }, 0);
}

// ---------------------------------------------------------------------------
// Create / cancel
// ---------------------------------------------------------------------------

export const createShipmentSchema = z.object({ orderId: z.uuid(), warehouseId: z.uuid().optional() });
export const manualShipmentSchema = z.object({
  orderId: z.uuid(),
  warehouseId: z.uuid().optional(),
  courierName: z.string().trim().min(2).max(80),
  awb: z.string().trim().min(4).max(40),
  trackingUrl: z.url().optional(),
});

async function shippableGroups(orderId: string, warehouseId?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { variant: { select: { weightGrams: true, product: { select: { weightGrams: true } } } } } }, shipments: true } });
  if (!order) throw notFound("Order");
  if (order.channel !== "ONLINE") throw badRequest("Only online orders are shipped");
  if (!["PAID", "PARTIALLY_REFUNDED"].includes(order.paymentStatus)) throw invalidState("Only paid orders can be shipped");
  if (!["CONFIRMED", "PROCESSING", "PACKED"].includes(order.status)) throw invalidState(`Orders that are ${order.status} cannot be shipped`);
  const shipped = new Set(order.shipments.filter((s) => !s.isReturn && s.status !== "CANCELLED" && s.status !== "FAILED").map((s) => s.warehouseId));
  const groups = new Map<string, typeof order.items>();
  for (const it of order.items) {
    if (shipped.has(it.warehouseId) || (warehouseId && it.warehouseId !== warehouseId)) continue;
    groups.set(it.warehouseId, [...(groups.get(it.warehouseId) ?? []), it]);
  }
  if (!groups.size) throw invalidState("All items of this order already have a shipment");
  return { order, groups };
}

export async function createShipments(input: z.infer<typeof createShipmentSchema>, ctx: AuditContext) {
  const { order, groups } = await shippableGroups(input.orderId, input.warehouseId);
  const settings = await getSetting("shipping");
  const addr = order.shippingAddress as Record<string, string> | null;
  if (!addr) throw invalidState("Order has no shipping address");
  const created: string[] = [];
  let index = 0;
  for (const [warehouseId, items] of groups) {
    index += 1;
    const weightGrams = items.reduce((s, i) => s + (i.variant.weightGrams ?? i.variant.product.weightGrams ?? settings.defaultWeightGrams) * i.quantity, 0);
    const reference = groups.size > 1 || order.shipments.length ? `${order.orderNumber}-${order.shipments.length + index}` : order.orderNumber;
    const res = await shippingService().createShipment({
      reference,
      orderDate: order.placedAt,
      pickupLocation: env.SHIPPING_PICKUP_LOCATION,
      pickupPostalCode: (await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } })).postalCode,
      shipTo: { name: addr.fullName ?? order.customerName ?? "Customer", phone: addr.phone ?? order.customerPhone ?? "", email: order.customerEmail, line1: addr.line1 ?? "", line2: addr.line2, city: addr.city ?? "", state: addr.state ?? "", postalCode: addr.postalCode ?? "", country: "IN" },
      items: items.map((i) => ({ name: i.productName, sku: i.sku, quantity: i.quantity, unitPrice: Math.round(i.lineTotal / i.quantity), hsnCode: i.hsnCode })),
      subTotal: items.reduce((s, i) => s + i.lineTotal, 0),
      weightGrams,
      lengthCm: settings.defaultLengthCm,
      widthCm: settings.defaultWidthCm,
      heightCm: settings.defaultHeightCm,
    });
    const ids = await withTransaction(async (tx) => {
      const shipment = await tx.shipment.create({
        data: {
          orderId: order.id,
          warehouseId,
          provider: shippingService().name,
          providerOrderId: res.providerOrderId,
          providerShipmentId: res.providerShipmentId,
          awb: res.awb,
          courierName: res.courierName,
          courierId: res.courierId,
          trackingUrl: res.trackingUrl ?? (res.awb ? `${env.WEB_URL}/track/${res.awb}` : null),
          labelUrl: res.labelUrl,
          status: res.status,
          shippingCost: res.shippingCost,
          weightGrams,
          estimatedDeliveryAt: res.estimatedDeliveryAt,
          events: { create: { status: res.status, rawStatus: "Shipment created", description: `Shipment created with ${res.courierName ?? "courier"}`, occurredAt: new Date() } },
        },
      });
      created.push(shipment.id);
      await audit(tx, ctx, { action: "shipment.create", entityType: "shipment", entityId: shipment.id, newValue: { orderId: order.id, awb: res.awb, warehouseId } });
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      return TRANSITIONS[current.status].includes("PACKED") ? changeStatus(tx, order.id, "PACKED", { note: `Shipment ${res.awb ?? reference} created`, userId: ctx.userId }) : [];
    });
    await dispatchNotifications(ids);
  }
  return prisma.shipment.findMany({ where: { id: { in: created } } });
}

export async function createManualShipment(input: z.infer<typeof manualShipmentSchema>, ctx: AuditContext) {
  const { order, groups } = await shippableGroups(input.orderId, input.warehouseId);
  const warehouseId = input.warehouseId ?? [...groups.keys()][0]!;
  const ids = await withTransaction(async (tx) => {
    const shipment = await tx.shipment.create({
      data: {
        orderId: order.id,
        warehouseId,
        provider: "MANUAL",
        awb: input.awb,
        courierName: input.courierName,
        trackingUrl: input.trackingUrl ?? null,
        status: "PICKED_UP",
        pickedUpAt: new Date(),
        events: { create: { status: "PICKED_UP", rawStatus: "Handed to courier", description: `Handed to ${input.courierName}`, occurredAt: new Date() } },
      },
    });
    await audit(tx, ctx, { action: "shipment.manual", entityType: "shipment", entityId: shipment.id, newValue: input });
    return changeStatus(tx, order.id, "SHIPPED", { userId: ctx.userId, note: `Shipped via ${input.courierName} (${input.awb})`, event: { type: "shipped", courier: input.courierName, awb: input.awb, trackingUrl: input.trackingUrl } });
  });
  await dispatchNotifications(ids);
  return prisma.shipment.findFirstOrThrow({ where: { orderId: order.id, awb: input.awb } });
}

export async function cancelShipment(id: string, ctx: AuditContext) {
  const s = await prisma.shipment.findUnique({ where: { id } });
  if (!s) throw notFound("Shipment");
  if (!["PENDING", "CREATED", "PICKUP_SCHEDULED"].includes(s.status)) throw invalidState("Shipments can only be cancelled before pickup");
  if (s.provider !== "MANUAL" && s.providerOrderId) await shippingService().cancelShipment({ providerOrderId: s.providerOrderId, awb: s.awb });
  await withTransaction(async (tx) => {
    await tx.shipment.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await tx.shipmentEvent.create({ data: { shipmentId: id, status: "CANCELLED", rawStatus: "Cancelled", description: "Shipment cancelled", occurredAt: new Date() } });
    await audit(tx, ctx, { action: "shipment.cancel", entityType: "shipment", entityId: id });
  });
  return prisma.shipment.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Applies provider tracking to a shipment and rolls the result up to the order. */
export async function applyTracking(shipmentId: string, tracking: Tracking) {
  const ids = await withTransaction(async (tx) => {
    const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    if (tracking.events.length) {
      await tx.shipmentEvent.createMany({ data: tracking.events.map((e) => ({ shipmentId, ...e })), skipDuplicates: true });
    }
    const status = tracking.status;
    await tx.shipment.update({
      where: { id: shipmentId },
      data: {
        status,
        lastSyncedAt: new Date(),
        estimatedDeliveryAt: tracking.estimatedDeliveryAt ?? undefined,
        pickedUpAt: !shipment.pickedUpAt && ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"].includes(status) ? new Date() : undefined,
        deliveredAt: status === "DELIVERED" && !shipment.deliveredAt ? new Date() : undefined,
      },
    });
    if (shipment.isReturn) return [];

    // Order status follows the least advanced of its active shipments.
    const shipments = await tx.shipment.findMany({ where: { orderId: shipment.orderId, isReturn: false, status: { notIn: ["CANCELLED", "FAILED"] } } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: shipment.orderId } });
    const all = (s: ShipmentStatus[]) => shipments.length > 0 && shipments.every((x) => s.includes(x.status));
    const any = (s: ShipmentStatus[]) => shipments.some((x) => s.includes(x.status));
    let target: "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED" | null = null;
    if (all(["DELIVERED"])) target = "DELIVERED";
    else if (any(["OUT_FOR_DELIVERY"])) target = "OUT_FOR_DELIVERY";
    else if (any(["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"])) target = "SHIPPED";

    const out: (string | null)[] = [];
    const steps: ("SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED")[] = ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];
    if (target) {
      // Walk through intermediate states so the history and notifications stay complete.
      for (const step of steps.slice(0, steps.indexOf(target) + 1)) {
        const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
        if (current.status === step || !TRANSITIONS[current.status].includes(step)) continue;
        out.push(
          ...(await changeStatus(tx, order.id, step, {
            note: `Courier update: ${status}`,
            event: step === "SHIPPED" ? { type: "shipped", courier: shipment.courierName, awb: shipment.awb, trackingUrl: shipment.trackingUrl } : undefined,
          })),
        );
      }
    }
    return out;
  });
  await dispatchNotifications(ids);
}

export async function refreshTracking(id: string) {
  const s = await prisma.shipment.findUnique({ where: { id } });
  if (!s) throw notFound("Shipment");
  if (s.provider !== "MANUAL" && s.providerShipmentId && !FINAL.includes(s.status)) {
    await applyTracking(id, await shippingService().getTracking({ awb: s.awb, providerShipmentId: s.providerShipmentId }));
  }
  return getShipment(id);
}

/** Periodic sync for parcels that are still moving (fallback when webhooks are missed). */
export async function syncActiveShipments() {
  // No courier service to ask.
  if (!courierEnabled) return { synced: 0, total: 0 };
  const active = await prisma.shipment.findMany({
    where: { status: { in: ACTIVE }, provider: { not: "MANUAL" }, createdAt: { gt: new Date(Date.now() - 45 * 86_400_000) } },
    select: { id: true },
    take: 200,
  });
  let ok = 0;
  for (const s of active) {
    try {
      await refreshTracking(s.id);
      ok += 1;
    } catch (err) {
      logger.warn({ shipmentId: s.id, err: (err as Error).message }, "tracking sync failed");
    }
  }
  return { synced: ok, total: active.length };
}

/** Development: move a mock parcel one step along its journey. */
export async function simulateNextStatus(id: string) {
  const mock = mockShipping();
  if (!mock) throw badRequest("Only available with the mock shipping provider");
  const s = await prisma.shipment.findUnique({ where: { id } });
  if (!s?.awb) throw notFound("Shipment");
  await mock.advance(s.awb);
  return refreshTracking(id);
}

// ---------------------------------------------------------------------------
// Webhook (Shiprocket)
// ---------------------------------------------------------------------------

interface ShiprocketHook {
  awb?: string | number;
  current_status?: string;
  current_timestamp?: string;
  scans?: { date: string; activity?: string; location?: string; "sr-status-label"?: string }[];
}

export async function ingestShippingWebhook(token: string | undefined, body: ShiprocketHook) {
  if (!env.SHIPPING_WEBHOOK_TOKEN || !token || !safeEqual(token, env.SHIPPING_WEBHOOK_TOKEN)) {
    throw new AppError(401, "INVALID_SIGNATURE", "Invalid webhook token");
  }
  const awb = body.awb ? String(body.awb) : null;
  const eventId = sha256(`${awb}|${body.current_status}|${body.current_timestamp}`);
  await prisma.webhookEvent.createMany({
    data: [{ provider: "SHIPROCKET", eventId, eventType: body.current_status ?? "update", payload: body as unknown as Prisma.InputJsonValue, signatureValid: true }],
    skipDuplicates: true,
  });
  const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "SHIPROCKET", eventId } } });
  if (event.status === "PROCESSED" || event.status === "IGNORED") return { duplicate: true };

  const shipment = awb ? await prisma.shipment.findUnique({ where: { awb } }) : null;
  if (!shipment) {
    await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "IGNORED", processedAt: new Date() } });
    return { ignored: true };
  }
  const events = (body.scans ?? []).map((s) => {
    const raw = s["sr-status-label"] ?? s.activity ?? "UPDATE";
    return { status: mapShipmentStatus(raw), rawStatus: raw, location: s.location ?? null, description: s.activity ?? null, occurredAt: new Date(s.date) };
  });
  await applyTracking(shipment.id, { status: mapShipmentStatus(body.current_status ?? "IN TRANSIT"), events, estimatedDeliveryAt: null });
  await prisma.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date(), attempts: { increment: 1 } } });
  return { processed: true };
}

// ---------------------------------------------------------------------------
// Labels & queries
// ---------------------------------------------------------------------------

/** Provider label URL when available, otherwise a locally rendered 4"×6" label. */
export async function shipmentLabel(id: string): Promise<{ url: string } | { pdf: Buffer }> {
  const s = await prisma.shipment.findUnique({ where: { id }, include: { order: true, warehouse: true } });
  if (!s) throw notFound("Shipment");
  if (s.provider === "SHIPROCKET" && s.providerShipmentId) {
    const url = s.labelUrl ?? (await shippingService().generateLabel({ providerShipmentId: s.providerShipmentId }));
    if (url) {
      if (!s.labelUrl) await prisma.shipment.update({ where: { id }, data: { labelUrl: url } });
      return { url };
    }
  }
  const store = await getSetting("store");
  const addr = (s.order.shippingAddress ?? {}) as Record<string, string>;
  const barcode = s.awb ? await renderCodePng({ codeType: "CODE128", codeValue: s.awb, qrPayload: null }, 3) : null;
  const pdf = await renderPdf(createPdf({ size: [101.6 * MM, 152.4 * MM], margin: 14 }), (d) => {
    d.font("bold").fontSize(12).text(s.courierName ?? "Courier", { align: "center" });
    if (barcode) d.image(barcode, 20, 40, { fit: [101.6 * MM - 40, 70], align: "center" });
    d.moveDown(6).font("bold").fontSize(9).text("SHIP TO");
    d.font("regular").fontSize(10).text([addr.fullName, addr.line1, addr.line2, `${addr.city}, ${addr.state} ${addr.postalCode}`, `Phone: ${addr.phone}`].filter(Boolean).join("\n"));
    d.moveDown().font("bold").fontSize(9).text("FROM");
    d.font("regular").fontSize(8).text([store.displayName, s.warehouse.addressLine1, `${s.warehouse.city} ${s.warehouse.postalCode}`].join("\n"));
    d.moveDown().fontSize(8).text(`Order ${s.order.orderNumber} · Prepaid · ${((s.weightGrams ?? 0) / 1000).toFixed(2)} kg`);
  });
  return { pdf };
}

export async function getShipment(id: string) {
  const s = await prisma.shipment.findUnique({
    where: { id },
    include: { events: { orderBy: { occurredAt: "desc" } }, order: { select: { id: true, orderNumber: true, customerName: true, status: true } }, warehouse: { select: { code: true, name: true } } },
  });
  if (!s) throw notFound("Shipment");
  return s;
}

export async function listShipments(q: { status?: ShipmentStatus; orderId?: string; q?: string }, page: Pagination) {
  const where: Prisma.ShipmentWhereInput = {
    status: q.status,
    orderId: q.orderId,
    OR: q.q ? [{ awb: { contains: q.q.toUpperCase() } }, { order: { orderNumber: { contains: q.q.toUpperCase() } } }] : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.shipment.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page), include: { order: { select: { orderNumber: true, customerName: true } }, warehouse: { select: { code: true } } } }),
    prisma.shipment.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

/** Customer-facing tracking for one of their orders. */
export async function customerTracking(userId: string, orderNumber: string) {
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId },
    select: { orderNumber: true, status: true, shipments: { where: { isReturn: false }, include: { events: { orderBy: { occurredAt: "desc" } } } } },
  });
  if (!order) throw notFound("Order");
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    shipments: order.shipments.map((s) => ({ courier: s.courierName, awb: s.awb, trackingUrl: s.trackingUrl, status: s.status, estimatedDeliveryAt: s.estimatedDeliveryAt, events: s.events })),
  };
}

