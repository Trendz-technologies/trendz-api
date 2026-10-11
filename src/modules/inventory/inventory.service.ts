import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { redis } from "../../database/redis";
import { nextYearlyNumber } from "../../database/sequences";
import { badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { audit, type AuditContext } from "../audit/audit.service";
import { createNotification, dispatchNotifications } from "../notifications/notifications.service";
import { getSetting } from "../settings/settings.service";
import { applyMovements, lockLevels, type Movement } from "./stock";

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export const adjustSchema = z.object({
  warehouseId: z.uuid(),
  reason: z.enum(["COUNT_CORRECTION", "DAMAGE", "LOSS", "FOUND", "EXPIRED", "OPENING_STOCK", "OTHER"]),
  notes: z.string().trim().max(500).nullable().optional(),
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        // COUNT_CORRECTION / OPENING_STOCK may set an absolute count; others use deltas.
        mode: z.enum(["delta", "set"]).default("delta"),
        quantity: z.number().int().min(-100_000).max(100_000),
        bucket: z.enum(["ON_HAND", "DAMAGED"]).default("ON_HAND"),
      }),
    )
    .min(1)
    .max(500),
});

export async function adjustStock(input: z.infer<typeof adjustSchema>, ctx: AuditContext) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId }, select: { id: true, status: true } });
  if (!warehouse) throw notFound("Warehouse");
  if (input.items.some((i) => i.mode === "set" && i.quantity < 0)) throw badRequest("Counts cannot be negative");
  if (!["COUNT_CORRECTION", "OPENING_STOCK"].includes(input.reason) && input.items.some((i) => i.mode === "set")) {
    throw badRequest("Only count corrections and opening stock can set an absolute quantity; use +/- quantities for other reasons");
  }
  if (input.reason === "DAMAGE" && input.items.some((i) => i.mode !== "delta" || i.quantity <= 0)) {
    throw badRequest("DAMAGE adjustments move a positive number of units from sellable stock to damaged");
  }
  if (["LOSS", "EXPIRED"].includes(input.reason) && input.items.some((i) => i.quantity >= 0 && i.mode === "delta")) {
    throw badRequest(`${input.reason} adjustments must reduce stock (negative quantities)`);
  }

  return withTransaction(async (tx) => {
    const number = await nextYearlyNumber(tx, "ADJ");
    const rows = await lockLevels(tx, input.items.map((i) => ({ variantId: i.variantId, warehouseId: input.warehouseId })));
    const variants = await tx.productVariant.findMany({ where: { id: { in: input.items.map((i) => i.variantId) } }, select: { id: true } });
    if (variants.length !== new Set(input.items.map((i) => i.variantId)).size) throw badRequest("One or more variants were not found");

    const movements: Movement[] = [];
    for (const item of input.items) {
      const row = rows.get(`${item.variantId}:${input.warehouseId}`)!;
      if (input.reason === "DAMAGE") {
        movements.push({ variantId: item.variantId, warehouseId: input.warehouseId, bucket: "ON_HAND", delta: -item.quantity, type: "DAMAGE" });
        movements.push({ variantId: item.variantId, warehouseId: input.warehouseId, bucket: "DAMAGED", delta: item.quantity, type: "DAMAGE" });
        continue;
      }
      const current = item.bucket === "ON_HAND" ? row.on_hand : row.damaged;
      const delta = item.mode === "set" ? item.quantity - current : item.quantity;
      movements.push({
        variantId: item.variantId,
        warehouseId: input.warehouseId,
        bucket: item.bucket,
        delta,
        type: input.reason === "COUNT_CORRECTION" ? "STOCK_CORRECTION" : "ADJUSTMENT",
      });
    }

    const adjustment = await tx.stockAdjustment.create({
      data: { number, warehouseId: input.warehouseId, reason: input.reason, notes: input.notes ?? null, createdById: ctx.userId },
    });
    const before = new Map([...rows.entries()].map(([k, r]) => [k, { ...r }]));
    await applyMovements(tx, movements, { referenceType: "ADJUSTMENT", referenceId: adjustment.id, referenceNumber: number, userId: ctx.userId, notes: input.notes ?? input.reason });

    const after = await tx.inventoryLevel.findMany({ where: { warehouseId: input.warehouseId, variantId: { in: movements.map((m) => m.variantId) } } });
    await tx.stockAdjustmentItem.createMany({
      data: movements.map((m) => {
        const b = before.get(`${m.variantId}:${m.warehouseId}`)!;
        const a = after.find((x) => x.variantId === m.variantId)!;
        const col = m.bucket === "ON_HAND" ? "onHand" : "damaged";
        return {
          adjustmentId: adjustment.id,
          variantId: m.variantId,
          bucket: m.bucket,
          quantityDelta: m.delta,
          balanceBefore: m.bucket === "ON_HAND" ? b.on_hand : b.damaged,
          balanceAfter: a[col],
        };
      }),
    });
    await audit(tx, ctx, { action: "inventory.adjust", entityType: "stock_adjustment", entityId: adjustment.id, newValue: input });
    return tx.stockAdjustment.findUniqueOrThrow({ where: { id: adjustment.id }, include: { items: { include: { variant: { select: { sku: true, title: true } } } } } });
  });
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const transferSchema = z
  .object({
    fromWarehouseId: z.uuid(),
    toWarehouseId: z.uuid(),
    notes: z.string().trim().max(500).nullable().optional(),
    items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().positive().max(100_000) })).min(1).max(500),
  })
  .refine((t) => t.fromWarehouseId !== t.toWarehouseId, "Source and destination must differ")
  .refine((t) => new Set(t.items.map((i) => i.variantId)).size === t.items.length, "Each variant can appear only once");

export const receiveTransferSchema = z.object({
  items: z.array(z.object({ variantId: z.uuid(), receivedQuantity: z.number().int().min(0) })).optional(),
  notes: z.string().trim().max(500).optional(),
});

const transferInclude = {
  fromWarehouse: { select: { id: true, code: true, name: true } },
  toWarehouse: { select: { id: true, code: true, name: true } },
  items: { include: { variant: { select: { sku: true, title: true, product: { select: { name: true } } } } } },
} satisfies Prisma.StockTransferInclude;

export async function createTransfer(input: z.infer<typeof transferSchema>, ctx: AuditContext) {
  const whs = await prisma.warehouse.findMany({ where: { id: { in: [input.fromWarehouseId, input.toWarehouseId] }, status: "ACTIVE" } });
  if (whs.length !== 2) throw badRequest("Both warehouses must exist and be active");
  return withTransaction(async (tx) => {
    const number = await nextYearlyNumber(tx, "TRF");
    const t = await tx.stockTransfer.create({
      data: {
        number,
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        notes: input.notes ?? null,
        createdById: ctx.userId,
        items: { create: input.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })) },
      },
      include: transferInclude,
    });
    await audit(tx, ctx, { action: "inventory.transfer.create", entityType: "stock_transfer", entityId: t.id, newValue: input });
    return t;
  });
}

async function loadTransferForUpdate(tx: Prisma.TransactionClient, id: string) {
  // Row lock on the transfer serialises dispatch / receive / cancel.
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE`;
  if (!locked.length) throw notFound("Transfer");
  return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } });
}

export async function dispatchTransfer(id: string, ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const t = await loadTransferForUpdate(tx, id);
    if (t.status !== "DRAFT") throw invalidState(`Transfer is ${t.status}; only DRAFT transfers can be dispatched`);
    await applyMovements(
      tx,
      t.items.map((i) => ({ variantId: i.variantId, warehouseId: t.fromWarehouseId, bucket: "ON_HAND" as const, delta: -i.quantity, type: "TRANSFER_OUT" as const })),
      { referenceType: "TRANSFER", referenceId: t.id, referenceNumber: t.number, userId: ctx.userId, notes: "Dispatched" },
    );
    await tx.stockTransfer.update({ where: { id }, data: { status: "IN_TRANSIT", dispatchedAt: new Date() } });
    await audit(tx, ctx, { action: "inventory.transfer.dispatch", entityType: "stock_transfer", entityId: id });
    return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
  });
}

export async function receiveTransfer(id: string, input: z.infer<typeof receiveTransferSchema>, ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const t = await loadTransferForUpdate(tx, id);
    if (t.status !== "IN_TRANSIT") throw invalidState(`Transfer is ${t.status}; only IN_TRANSIT transfers can be received`);
    const received = new Map((input.items ?? []).map((i) => [i.variantId, i.receivedQuantity]));
    for (const [variantId, qty] of received) {
      const item = t.items.find((i) => i.variantId === variantId);
      if (!item) throw badRequest(`Variant ${variantId} is not part of this transfer`);
      if (qty > item.quantity) throw badRequest("Cannot receive more than was dispatched");
    }
    const lines = t.items.map((i) => ({ ...i, receivedQuantity: received.get(i.variantId) ?? i.quantity }));
    await applyMovements(
      tx,
      lines.map((i) => ({ variantId: i.variantId, warehouseId: t.toWarehouseId, bucket: "ON_HAND" as const, delta: i.receivedQuantity, type: "TRANSFER_IN" as const })),
      { referenceType: "TRANSFER", referenceId: t.id, referenceNumber: t.number, userId: ctx.userId, notes: input.notes ?? "Received" },
    );
    for (const i of lines) await tx.stockTransferItem.update({ where: { id: i.id }, data: { receivedQuantity: i.receivedQuantity } });
    const shortfall = lines.filter((i) => i.receivedQuantity < i.quantity).map((i) => ({ variantId: i.variantId, missing: i.quantity - i.receivedQuantity }));
    await tx.stockTransfer.update({
      where: { id },
      data: { status: "RECEIVED", receivedAt: new Date(), notes: shortfall.length ? `${t.notes ?? ""}\nShortfall on receipt: ${JSON.stringify(shortfall)}`.trim() : t.notes },
    });
    await audit(tx, ctx, { action: "inventory.transfer.receive", entityType: "stock_transfer", entityId: id, newValue: { lines: lines.map((l) => ({ variantId: l.variantId, received: l.receivedQuantity })), shortfall } });
    return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
  });
}

export async function cancelTransfer(id: string, ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const t = await loadTransferForUpdate(tx, id);
    if (t.status === "RECEIVED" || t.status === "CANCELLED") throw invalidState(`Transfer is already ${t.status}`);
    if (t.status === "IN_TRANSIT") {
      // Goods never arrived: put them back at the source.
      await applyMovements(
        tx,
        t.items.map((i) => ({ variantId: i.variantId, warehouseId: t.fromWarehouseId, bucket: "ON_HAND" as const, delta: i.quantity, type: "TRANSFER_IN" as const })),
        { referenceType: "TRANSFER", referenceId: t.id, referenceNumber: t.number, userId: ctx.userId, notes: "Transfer cancelled; returned to source" },
      );
    }
    await tx.stockTransfer.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await audit(tx, ctx, { action: "inventory.transfer.cancel", entityType: "stock_transfer", entityId: id, oldValue: t.status });
    return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
  });
}

export async function listTransfers(filter: { status?: string; warehouseId?: string }, page: Pagination) {
  const where: Prisma.StockTransferWhereInput = {
    status: filter.status as Prisma.StockTransferWhereInput["status"],
    OR: filter.warehouseId ? [{ fromWarehouseId: filter.warehouseId }, { toWarehouseId: filter.warehouseId }] : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.stockTransfer.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page), include: { ...transferInclude, items: { select: { quantity: true, receivedQuantity: true } } } }),
    prisma.stockTransfer.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export async function getTransfer(id: string) {
  const t = await prisma.stockTransfer.findUnique({ where: { id }, include: transferInclude });
  if (!t) throw notFound("Transfer");
  return t;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const levelsQuery = z.object({
  warehouseId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", "in_stock", "low", "out"]).default("all"),
});

/** Stock levels per variant (and per warehouse when one is selected). */
export async function listLevels(query: z.infer<typeof levelsQuery>, page: Pagination) {
  const { defaultLowStockThreshold } = await getSetting("inventory");
  const conditions: Prisma.Sql[] = [Prisma.sql`v.status <> 'DISCONTINUED'`];
  if (query.q) {
    const like = `%${query.q}%`;
    conditions.push(Prisma.sql`(v.sku ILIKE ${like} OR p.name ILIKE ${like})`);
  }
  const whFilter = query.warehouseId ? Prisma.sql`AND il.warehouse_id = ${query.warehouseId}::uuid` : Prisma.empty;
  const threshold = Prisma.sql`COALESCE(v.low_stock_threshold, NULLIF(p.min_stock_level, 0), ${defaultLowStockThreshold})`;
  const having =
    query.status === "out"
      ? Prisma.sql`HAVING COALESCE(SUM(il.on_hand - il.reserved), 0) <= 0`
      : query.status === "low"
        ? Prisma.sql`HAVING COALESCE(SUM(il.on_hand - il.reserved), 0) > 0 AND COALESCE(SUM(il.on_hand - il.reserved), 0) <= ${threshold}`
        : query.status === "in_stock"
          ? Prisma.sql`HAVING COALESCE(SUM(il.on_hand - il.reserved), 0) > 0`
          : Prisma.empty;

  const rows = await prisma.$queryRaw<
    { variant_id: string; sku: string; title: string; product_id: string; product_name: string; on_hand: bigint; reserved: bigint; damaged: bigint; returned: bigint; threshold: number; cost_price: number | null; total: bigint }[]
  >`
    SELECT v.id AS variant_id, v.sku, v.title, p.id AS product_id, p.name AS product_name,
           COALESCE(SUM(il.on_hand), 0) AS on_hand, COALESCE(SUM(il.reserved), 0) AS reserved,
           COALESCE(SUM(il.damaged), 0) AS damaged, COALESCE(SUM(il.returned), 0) AS returned,
           ${threshold} AS threshold, v.cost_price,
           COUNT(*) OVER() AS total
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN inventory_levels il ON il.variant_id = v.id ${whFilter}
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY v.id, p.id
    ${having}
    ORDER BY p.name, v.position
    LIMIT ${page.limit} OFFSET ${(page.page - 1) * page.limit}`;

  const total = rows.length ? Number(rows[0]!.total) : 0;
  return {
    items: rows.map((r) => {
      const onHand = Number(r.on_hand);
      const reserved = Number(r.reserved);
      const available = onHand - reserved;
      return {
        variantId: r.variant_id,
        sku: r.sku,
        title: r.title,
        productId: r.product_id,
        productName: r.product_name,
        onHand,
        reserved,
        available,
        damaged: Number(r.damaged),
        returned: Number(r.returned),
        lowStockThreshold: Number(r.threshold),
        status: available <= 0 ? "OUT" : available <= Number(r.threshold) ? "LOW" : "IN_STOCK",
        stockValue: r.cost_price != null ? onHand * r.cost_price : null,
      };
    }),
    meta: pageMeta(page, total),
  };
}

export async function variantStock(variantId: string) {
  const v = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      sku: true,
      title: true,
      product: { select: { id: true, name: true } },
      inventoryLevels: { include: { warehouse: { select: { id: true, code: true, name: true } }, location: { select: { code: true } } } },
      reservations: { where: { status: "ACTIVE" }, select: { quantity: true, warehouseId: true, expiresAt: true, orderId: true } },
    },
  });
  if (!v) throw notFound("Variant");
  return {
    ...v,
    inventoryLevels: v.inventoryLevels.map((l) => ({ ...l, available: l.onHand - l.reserved })),
    totals: v.inventoryLevels.reduce(
      (t, l) => ({ onHand: t.onHand + l.onHand, reserved: t.reserved + l.reserved, available: t.available + l.onHand - l.reserved, damaged: t.damaged + l.damaged }),
      { onHand: 0, reserved: 0, available: 0, damaged: 0 },
    ),
  };
}

export const ledgerQuery = z.object({
  variantId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  type: z
    .enum(["PURCHASE", "SALE", "RETURN", "REFUND", "DAMAGE", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT", "STOCK_CORRECTION", "RESERVATION", "RESERVATION_RELEASE"])
    .optional(),
  referenceType: z.string().max(30).optional(),
  referenceId: z.string().max(100).optional(),
  sku: z.string().max(50).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function listLedger(q: z.infer<typeof ledgerQuery>, page: Pagination) {
  const where: Prisma.InventoryTransactionWhereInput = {
    variantId: q.variantId,
    warehouseId: q.warehouseId,
    type: q.type,
    referenceType: q.referenceType,
    referenceId: q.referenceId,
    sku: q.sku ? { contains: q.sku.toUpperCase() } : undefined,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      include: { warehouse: { select: { code: true, name: true } }, variant: { select: { title: true, product: { select: { name: true } } } } },
    }),
    prisma.inventoryTransaction.count({ where }),
  ]);
  const userIds = [...new Set(items.map((i) => i.userId).filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } } });
  return {
    items: items.map((i) => {
      const u = users.find((x) => x.id === i.userId);
      return { ...i, user: u ? { id: u.id, email: u.email, name: [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(" ") } : null };
    }),
    meta: pageMeta(page, total),
  };
}

// ---------------------------------------------------------------------------
// Low-stock alerts
// ---------------------------------------------------------------------------

export async function lowStockVariants(variantIds?: string[]) {
  const { items } = await listLevels({ status: "low" }, { page: 1, limit: 100 });
  const out = await listLevels({ status: "out" }, { page: 1, limit: 100 });
  const all = [...items, ...out.items];
  return variantIds ? all.filter((i) => variantIds.includes(i.variantId)) : all;
}

/** Queues a check after stock decreases; de-duplicated per variant per hour. */
export async function queueLowStockCheck(variantIds: string[]) {
  if (!variantIds.length) return;
  const hour = new Date().toISOString().slice(0, 13);
  await enqueue(QUEUE_NAMES.maintenance, "inventory.low-stock-check", { variantIds }, { jobId: `lowstock-${hour}-${[...variantIds].sort().join(",").slice(0, 200)}` });
}

/** Sends at most one alert per variant per day (email digest + in-app for inventory staff). */
export async function sendLowStockAlerts(variantIds?: string[]) {
  const low = await lowStockVariants(variantIds);
  const day = new Date().toISOString().slice(0, 10);
  const fresh: typeof low = [];
  for (const item of low) {
    const first = await redis.set(`alert:lowstock:${item.variantId}:${day}`, "1", "EX", 26 * 3600, "NX");
    if (first) fresh.push(item);
  }
  if (!fresh.length) return { alerted: 0 };

  const [inventory, notifications] = await Promise.all([getSetting("inventory"), getSetting("notifications")]);
  const emails = [...new Set([...inventory.lowStockAlertEmails, ...notifications.adminEmails])];
  const staff = await prisma.user.findMany({
    where: { isStaff: true, status: "ACTIVE", roles: { some: { role: { OR: [{ code: "SUPER_ADMIN" }, { permissions: { some: { permission: { code: "inventory.read" } } } }] } } } },
    select: { id: true },
  });
  const ids: (string | null)[] = [];
  for (const to of emails) {
    ids.push(
      await createNotification(prisma, {
        channel: "EMAIL",
        template: "admin.low_stock",
        to,
        data: { items: fresh.map((i) => ({ sku: i.sku, name: `${i.productName} (${i.title})`, warehouse: "All", available: i.available, threshold: i.lowStockThreshold })) },
        idempotencyKey: `lowstock:${day}:${to}:${fresh.map((f) => f.variantId).sort().join(",").slice(0, 100)}`,
      }),
    );
  }
  for (const s of staff) {
    ids.push(
      await createNotification(prisma, {
        channel: "IN_APP",
        userId: s.id,
        title: `Low stock: ${fresh.length} SKU(s)`,
        body: fresh.slice(0, 5).map((i) => `${i.sku} — ${i.available} left`).join(", "),
        link: "/admin/inventory?status=low",
      }),
    );
  }
  await dispatchNotifications(ids);
  return { alerted: fresh.length };
}
