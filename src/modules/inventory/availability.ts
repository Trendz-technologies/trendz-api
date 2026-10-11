import { prisma, type Db } from "../../database/prisma";

export interface Availability {
  onHand: number;
  reserved: number;
  available: number;
}

const EMPTY: Availability = { onHand: 0, reserved: 0, available: 0 };

/** Warehouses that fulfil online orders, in allocation priority order. */
export function onlineWarehouses(db: Db = prisma) {
  return db.warehouse.findMany({
    where: { status: "ACTIVE", isOnlineFulfillment: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true, code: true, name: true, stateCode: true },
  });
}

/**
 * Stock per variant summed over the given warehouses (default: online
 * fulfilment warehouses). Read-only and unlocked: use it for display only —
 * checkout re-checks stock under row locks.
 */
export async function availabilityByVariant(
  variantIds: string[],
  warehouseIds?: string[],
  db: Db = prisma,
): Promise<Map<string, Availability>> {
  const result = new Map<string, Availability>();
  if (variantIds.length === 0) return result;
  const whIds = warehouseIds ?? (await onlineWarehouses(db)).map((w) => w.id);
  const rows = await db.inventoryLevel.groupBy({
    by: ["variantId"],
    where: { variantId: { in: variantIds }, warehouseId: { in: whIds } },
    _sum: { onHand: true, reserved: true },
  });
  for (const r of rows) {
    const onHand = r._sum.onHand ?? 0;
    const reserved = r._sum.reserved ?? 0;
    result.set(r.variantId, { onHand, reserved, available: Math.max(0, onHand - reserved) });
  }
  for (const id of variantIds) if (!result.has(id)) result.set(id, { ...EMPTY });
  return result;
}
