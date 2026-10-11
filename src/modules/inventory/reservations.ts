import type { Tx } from "../../database/prisma";
import { applyMovements, type Movement } from "./stock";

export interface ReservationLine {
  variantId: string;
  warehouseId: string;
  quantity: number;
}

interface RefCtx {
  orderId: string;
  orderNumber: string;
  userId?: string | null;
  allowNegative?: boolean;
}

/**
 * Holds stock for an order: reserved += qty (validated under row lock so two
 * customers can never both get the last unit). Creates stock_reservations rows
 * that expire unless the order is paid.
 */
export async function reserveStock(tx: Tx, lines: ReservationLine[], expiresAt: Date, ctx: RefCtx) {
  const merged = mergeLines(lines);
  await applyMovements(
    tx,
    merged.map<Movement>((l) => ({ ...l, bucket: "RESERVED", delta: l.quantity, type: "RESERVATION" })),
    { referenceType: "ORDER", referenceId: ctx.orderId, referenceNumber: ctx.orderNumber, userId: ctx.userId, allowNegative: ctx.allowNegative, notes: "Reserved for order" },
  );
  await tx.stockReservation.createMany({
    data: merged.map((l) => ({ orderId: ctx.orderId, variantId: l.variantId, warehouseId: l.warehouseId, quantity: l.quantity, expiresAt })),
  });
}

/** Releases every ACTIVE reservation of an order (cancellation / payment expiry). */
export async function releaseReservations(tx: Tx, ctx: RefCtx & { reason: string; expired?: boolean }): Promise<number> {
  const active = await tx.stockReservation.findMany({ where: { orderId: ctx.orderId, status: "ACTIVE" } });
  if (active.length === 0) return 0;
  // Flip status first with a conditional update so concurrent releases are no-ops.
  const flipped = await tx.stockReservation.updateMany({
    where: { id: { in: active.map((r) => r.id) }, status: "ACTIVE" },
    data: { status: ctx.expired ? "EXPIRED" : "RELEASED" },
  });
  if (flipped.count !== active.length) return 0;
  await applyMovements(
    tx,
    active.map<Movement>((r) => ({ variantId: r.variantId, warehouseId: r.warehouseId, bucket: "RESERVED", delta: -r.quantity, type: "RESERVATION_RELEASE" })),
    { referenceType: "ORDER", referenceId: ctx.orderId, referenceNumber: ctx.orderNumber, userId: ctx.userId, notes: ctx.reason },
  );
  return active.length;
}

/**
 * Converts an order's reservations into a sale: reserved -= qty and
 * on_hand -= qty, both recorded as SALE movements. Idempotent: only ACTIVE
 * reservations are consumed.
 */
export async function consumeReservations(tx: Tx, ctx: RefCtx): Promise<ReservationLine[]> {
  const active = await tx.stockReservation.findMany({ where: { orderId: ctx.orderId, status: "ACTIVE" } });
  if (active.length === 0) return [];
  const flipped = await tx.stockReservation.updateMany({ where: { id: { in: active.map((r) => r.id) }, status: "ACTIVE" }, data: { status: "CONSUMED" } });
  if (flipped.count !== active.length) return [];
  await applyMovements(
    tx,
    active.flatMap<Movement>((r) => [
      { variantId: r.variantId, warehouseId: r.warehouseId, bucket: "RESERVED", delta: -r.quantity, type: "SALE" },
      { variantId: r.variantId, warehouseId: r.warehouseId, bucket: "ON_HAND", delta: -r.quantity, type: "SALE" },
    ]),
    { referenceType: "ORDER", referenceId: ctx.orderId, referenceNumber: ctx.orderNumber, userId: ctx.userId, allowNegative: ctx.allowNegative, notes: "Sold" },
  );
  return active.map((r) => ({ variantId: r.variantId, warehouseId: r.warehouseId, quantity: r.quantity }));
}

/** Immediate sale without a prior reservation (POS cash / UPI sales). */
export async function sellDirect(tx: Tx, lines: ReservationLine[], ctx: RefCtx) {
  await applyMovements(
    tx,
    mergeLines(lines).map<Movement>((l) => ({ ...l, bucket: "ON_HAND", delta: -l.quantity, type: "SALE" })),
    { referenceType: "ORDER", referenceId: ctx.orderId, referenceNumber: ctx.orderNumber, userId: ctx.userId, allowNegative: ctx.allowNegative, notes: "Sold at POS" },
  );
}

function mergeLines(lines: ReservationLine[]): ReservationLine[] {
  const map = new Map<string, ReservationLine>();
  for (const l of lines) {
    const k = `${l.variantId}:${l.warehouseId}`;
    const existing = map.get(k);
    if (existing) existing.quantity += l.quantity;
    else map.set(k, { ...l });
  }
  return [...map.values()].filter((l) => l.quantity > 0);
}
