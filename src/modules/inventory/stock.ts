import { Prisma, type InventoryMovementType, type StockBucket } from "@prisma/client";
import type { Tx } from "../../database/prisma";
import { AppError } from "../../common/errors/app-error";

/**
 * The only code path that changes stock.
 *
 * Every call:
 *   1. makes sure an inventory_levels row exists for each (variant, warehouse)
 *   2. locks those rows with SELECT ... FOR UPDATE in a stable order
 *      (variant_id, warehouse_id) so concurrent transactions cannot deadlock
 *   3. validates the resulting balances
 *   4. updates the rows and appends one inventory_transactions row per change
 *
 * It must run inside the caller's transaction so the ledger, the stock level
 * and the business document (order, receipt, transfer...) commit together.
 */

export interface Movement {
  variantId: string;
  warehouseId: string;
  bucket: StockBucket;
  delta: number;
  type: InventoryMovementType;
}

export interface MovementContext {
  referenceType?: string;
  referenceId?: string;
  referenceNumber?: string;
  userId?: string | null;
  notes?: string | null;
  /** Permits on_hand below zero / below reserved (POS stock override). */
  allowNegative?: boolean;
}

export interface LevelRow {
  id: string;
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  damaged: number;
  returned: number;
}

const COLUMN: Record<StockBucket, keyof Pick<LevelRow, "on_hand" | "reserved" | "damaged" | "returned">> = {
  ON_HAND: "on_hand",
  RESERVED: "reserved",
  DAMAGED: "damaged",
  RETURNED: "returned",
};

const key = (variantId: string, warehouseId: string) => `${variantId}:${warehouseId}`;

/** Creates missing rows, then locks every row in a deterministic order. */
export async function lockLevels(tx: Tx, pairs: { variantId: string; warehouseId: string }[]): Promise<Map<string, LevelRow>> {
  const unique = [...new Map(pairs.map((p) => [key(p.variantId, p.warehouseId), p])).values()].sort((a, b) =>
    a.variantId === b.variantId ? a.warehouseId.localeCompare(b.warehouseId) : a.variantId.localeCompare(b.variantId),
  );
  if (unique.length === 0) return new Map();

  await tx.$executeRaw`
    INSERT INTO inventory_levels (id, variant_id, warehouse_id, on_hand, reserved, damaged, returned, updated_at)
    SELECT gen_random_uuid(), v, w, 0, 0, 0, 0, now()
    FROM UNNEST(${unique.map((u) => u.variantId)}::uuid[], ${unique.map((u) => u.warehouseId)}::uuid[]) AS t(v, w)
    ON CONFLICT (variant_id, warehouse_id) DO NOTHING`;

  const conditions = unique.map((u) => Prisma.sql`(variant_id = ${u.variantId}::uuid AND warehouse_id = ${u.warehouseId}::uuid)`);
  const rows = await tx.$queryRaw<LevelRow[]>`
    SELECT id, variant_id, warehouse_id, on_hand, reserved, damaged, returned
    FROM inventory_levels
    WHERE ${Prisma.join(conditions, " OR ")}
    ORDER BY variant_id, warehouse_id
    FOR UPDATE`;
  return new Map(rows.map((r) => [key(r.variant_id, r.warehouse_id), r]));
}

export class InsufficientStockError extends AppError {
  constructor(
    public readonly sku: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      409,
      "OUT_OF_STOCK",
      available <= 0 ? `${sku} is out of stock` : `Only ${available} unit(s) of ${sku} are available`,
      [{ path: sku, message: `available ${Math.max(0, available)}, requested ${requested}` }],
    );
  }
}

/**
 * Applies movements atomically. Returns the locked rows after the change.
 * Movements on the same row are applied in order (e.g. reserve then consume).
 */
export async function applyMovements(tx: Tx, movements: Movement[], ctx: MovementContext): Promise<Map<string, LevelRow>> {
  const nonZero = movements.filter((m) => m.delta !== 0);
  if (nonZero.length === 0) return new Map();
  const rows = await lockLevels(tx, nonZero);

  const skus = new Map(
    (await tx.productVariant.findMany({ where: { id: { in: [...new Set(nonZero.map((m) => m.variantId))] } }, select: { id: true, sku: true } })).map(
      (v) => [v.id, v.sku],
    ),
  );

  const ledger: Prisma.InventoryTransactionCreateManyInput[] = [];
  const touched = new Set<string>();
  for (const m of nonZero) {
    const row = rows.get(key(m.variantId, m.warehouseId))!;
    const col = COLUMN[m.bucket];
    const before = row[col];
    const after = before + m.delta;
    const sku = skus.get(m.variantId) ?? m.variantId;

    if (m.bucket === "ON_HAND" && m.delta < 0 && !ctx.allowNegative) {
      // Sellable stock may never drop below what is promised to open orders.
      const available = row.on_hand - row.reserved;
      if (after < row.reserved) throw new InsufficientStockError(sku, available, -m.delta);
    }
    if (m.bucket === "RESERVED") {
      if (after < 0) throw new AppError(409, "INVALID_STATE", `Cannot release more reserved stock than is held for ${sku}`);
      if (m.delta > 0 && after > row.on_hand && !ctx.allowNegative) {
        throw new InsufficientStockError(sku, row.on_hand - before, m.delta);
      }
    }
    if ((m.bucket === "DAMAGED" || m.bucket === "RETURNED") && after < 0) {
      throw new AppError(409, "INVALID_STATE", `Only ${before} unit(s) of ${sku} are in the ${m.bucket.toLowerCase()} bucket`);
    }

    row[col] = after;
    touched.add(key(m.variantId, m.warehouseId));
    ledger.push({
      variantId: m.variantId,
      warehouseId: m.warehouseId,
      sku,
      type: m.type,
      bucket: m.bucket,
      quantity: m.delta,
      balanceBefore: before,
      balanceAfter: after,
      referenceType: ctx.referenceType ?? null,
      referenceId: ctx.referenceId ?? null,
      referenceNumber: ctx.referenceNumber ?? null,
      userId: ctx.userId ?? null,
      notes: ctx.notes ?? null,
    });
  }

  for (const k of touched) {
    const r = rows.get(k)!;
    await tx.$executeRaw`
      UPDATE inventory_levels
      SET on_hand = ${r.on_hand}, reserved = ${r.reserved}, damaged = ${r.damaged}, returned = ${r.returned}, updated_at = now()
      WHERE id = ${r.id}::uuid`;
  }
  await tx.inventoryTransaction.createMany({ data: ledger });
  return rows;
}
