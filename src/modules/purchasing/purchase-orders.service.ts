import { z } from "zod";
import { Prisma, type PurchaseOrderStatus } from "@prisma/client";
import { prisma, withTransaction, type Tx } from "../../database/prisma";
import { nextYearlyNumber } from "../../database/sequences";
import { badRequest, invalidState, notFound } from "../../common/errors/app-error";
import { applyBps } from "../../common/utils/money";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { audit, type AuditContext } from "../audit/audit.service";
import { applyMovements, type Movement } from "../inventory/stock";

export const poItemSchema = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().positive().max(1_000_000),
  unitCost: z.number().int().min(0).max(100_000_000), // paise, excluding GST
  taxRateBps: z.number().int().min(0).max(10_000).default(0),
});

export const poSchema = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  expectedDeliveryDate: z.coerce.date().nullable().optional(),
  shippingCost: z.number().int().min(0).max(100_000_000).default(0),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z
    .array(poItemSchema)
    .min(1)
    .max(500)
    .refine((items) => new Set(items.map((i) => i.variantId)).size === items.length, "Each variant can appear only once"),
});

export const receiveSchema = z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z
    .array(
      z.object({
        purchaseOrderItemId: z.uuid(),
        quantityReceived: z.number().int().min(0).max(1_000_000),
        quantityDamaged: z.number().int().min(0).max(1_000_000).default(0),
      }),
    )
    .min(1),
});

export const poListQuery = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED", "CANCELLED"]).optional(),
  supplierId: z.uuid().optional(),
  q: z.string().trim().max(50).optional(),
});

const include = {
  supplier: { select: { id: true, code: true, name: true, gstin: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  items: { include: { variant: { select: { sku: true, title: true, product: { select: { name: true } } } } } },
  receipts: { orderBy: { receivedAt: "desc" }, include: { items: true } },
} satisfies Prisma.PurchaseOrderInclude;

/** Server-side totals; client-sent totals are never used. */
async function buildItems(input: z.infer<typeof poSchema>) {
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: input.items.map((i) => i.variantId) } },
    select: { id: true, sku: true, title: true, product: { select: { name: true } } },
  });
  if (variants.length !== input.items.length) throw badRequest("One or more variants were not found");
  const items = input.items.map((i) => {
    const v = variants.find((x) => x.id === i.variantId)!;
    const net = i.quantity * i.unitCost;
    const taxAmount = applyBps(net, i.taxRateBps);
    return {
      variantId: i.variantId,
      sku: v.sku,
      description: v.title === "Default" ? v.product.name : `${v.product.name} — ${v.title}`,
      quantityOrdered: i.quantity,
      unitCost: i.unitCost,
      taxRateBps: i.taxRateBps,
      taxAmount,
      lineTotal: net + taxAmount,
    };
  });
  const subtotal = items.reduce((s, i) => s + i.quantityOrdered * i.unitCost, 0);
  const taxTotal = items.reduce((s, i) => s + i.taxAmount, 0);
  return { items, subtotal, taxTotal, grandTotal: subtotal + taxTotal + input.shippingCost };
}

async function assertParties(input: z.infer<typeof poSchema>) {
  const [supplier, warehouse] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: input.supplierId }, select: { status: true } }),
    prisma.warehouse.findUnique({ where: { id: input.warehouseId }, select: { status: true } }),
  ]);
  if (!supplier || supplier.status !== "ACTIVE") throw badRequest("Supplier not found or inactive");
  if (!warehouse || warehouse.status !== "ACTIVE") throw badRequest("Receiving warehouse not found or inactive");
}

export async function createPurchaseOrder(input: z.infer<typeof poSchema>, ctx: AuditContext) {
  await assertParties(input);
  const built = await buildItems(input);
  return withTransaction(async (tx) => {
    const number = await nextYearlyNumber(tx, "PO");
    const po = await tx.purchaseOrder.create({
      data: {
        number,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        shippingCost: input.shippingCost,
        notes: input.notes ?? null,
        subtotal: built.subtotal,
        taxTotal: built.taxTotal,
        grandTotal: built.grandTotal,
        createdById: ctx.userId,
        items: { create: built.items },
      },
      include,
    });
    await audit(tx, ctx, { action: "purchase_order.create", entityType: "purchase_order", entityId: po.id, newValue: input });
    return po;
  });
}

async function lockPo(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("Purchase order");
  return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { items: true } });
}

export async function updatePurchaseOrder(id: string, input: z.infer<typeof poSchema>, ctx: AuditContext) {
  await assertParties(input);
  const built = await buildItems(input);
  return withTransaction(async (tx) => {
    const before = await lockPo(tx, id);
    if (before.status !== "DRAFT") throw invalidState("Only draft purchase orders can be edited");
    await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });
    const po = await tx.purchaseOrder.update({
      where: { id },
      data: {
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        expectedDeliveryDate: input.expectedDeliveryDate ?? null,
        shippingCost: input.shippingCost,
        notes: input.notes ?? null,
        subtotal: built.subtotal,
        taxTotal: built.taxTotal,
        grandTotal: built.grandTotal,
        items: { create: built.items },
      },
      include,
    });
    await audit(tx, ctx, { action: "purchase_order.update", entityType: "purchase_order", entityId: id, oldValue: before, newValue: input });
    return po;
  });
}

const TRANSITIONS: Record<"submit" | "approve" | "cancel" | "close", { from: PurchaseOrderStatus[]; to: PurchaseOrderStatus }> = {
  submit: { from: ["DRAFT"], to: "SUBMITTED" },
  approve: { from: ["SUBMITTED"], to: "APPROVED" },
  cancel: { from: ["DRAFT", "SUBMITTED", "APPROVED"], to: "CANCELLED" },
  close: { from: ["PARTIALLY_RECEIVED", "RECEIVED"], to: "CLOSED" },
};

export async function transitionPurchaseOrder(id: string, action: keyof typeof TRANSITIONS, ctx: AuditContext) {
  const rule = TRANSITIONS[action];
  return withTransaction(async (tx) => {
    const po = await lockPo(tx, id);
    if (!rule.from.includes(po.status)) throw invalidState(`Cannot ${action} a purchase order that is ${po.status}`);
    const now = new Date();
    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: {
        status: rule.to,
        submittedAt: action === "submit" ? now : undefined,
        approvedAt: action === "approve" ? now : undefined,
        approvedById: action === "approve" ? ctx.userId : undefined,
        cancelledAt: action === "cancel" ? now : undefined,
        closedAt: action === "close" ? now : undefined,
      },
      include,
    });
    await audit(tx, ctx, { action: `purchase_order.${action}`, entityType: "purchase_order", entityId: id, oldValue: po.status, newValue: rule.to });
    return updated;
  });
}

/**
 * Goods received note. Good units go to on_hand, damaged units to the damaged
 * bucket, both as PURCHASE ledger movements referencing the GRN.
 */
export async function receiveGoods(id: string, input: z.infer<typeof receiveSchema>, ctx: AuditContext) {
  return withTransaction(async (tx) => {
    const po = await lockPo(tx, id);
    if (po.status !== "APPROVED" && po.status !== "PARTIALLY_RECEIVED") {
      throw invalidState(`Goods can only be received against an approved purchase order (this one is ${po.status})`);
    }
    const lines = input.items.filter((i) => i.quantityReceived + i.quantityDamaged > 0);
    if (!lines.length) throw badRequest("Enter at least one received quantity");

    for (const line of lines) {
      const item = po.items.find((i) => i.id === line.purchaseOrderItemId);
      if (!item) throw badRequest("Item does not belong to this purchase order");
      const pending = item.quantityOrdered - item.quantityReceived;
      if (line.quantityReceived + line.quantityDamaged > pending) {
        throw badRequest(`${item.sku}: receiving ${line.quantityReceived + line.quantityDamaged} but only ${pending} pending`);
      }
    }

    const number = await nextYearlyNumber(tx, "GRN");
    const receipt = await tx.goodsReceipt.create({
      data: {
        number,
        purchaseOrderId: id,
        warehouseId: po.warehouseId,
        receivedById: ctx.userId,
        notes: input.notes ?? null,
        items: {
          create: lines.map((l) => ({
            purchaseOrderItemId: l.purchaseOrderItemId,
            variantId: po.items.find((i) => i.id === l.purchaseOrderItemId)!.variantId,
            quantityReceived: l.quantityReceived,
            quantityDamaged: l.quantityDamaged,
          })),
        },
      },
    });

    const movements: Movement[] = lines.flatMap((l) => {
      const variantId = po.items.find((i) => i.id === l.purchaseOrderItemId)!.variantId;
      return [
        { variantId, warehouseId: po.warehouseId, bucket: "ON_HAND" as const, delta: l.quantityReceived, type: "PURCHASE" as const },
        { variantId, warehouseId: po.warehouseId, bucket: "DAMAGED" as const, delta: l.quantityDamaged, type: "PURCHASE" as const },
      ];
    });
    await applyMovements(tx, movements, { referenceType: "GOODS_RECEIPT", referenceId: receipt.id, referenceNumber: `${number} / ${po.number}`, userId: ctx.userId, notes: input.notes ?? "Goods received" });

    for (const l of lines) {
      await tx.purchaseOrderItem.update({
        where: { id: l.purchaseOrderItemId },
        data: { quantityReceived: { increment: l.quantityReceived + l.quantityDamaged } },
      });
    }
    const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } });
    const complete = items.every((i) => i.quantityReceived >= i.quantityOrdered);
    const updated = await tx.purchaseOrder.update({ where: { id }, data: { status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED" }, include });
    await audit(tx, ctx, { action: "purchase_order.receive", entityType: "purchase_order", entityId: id, newValue: { receipt: number, lines } });
    return updated;
  });
}

export async function getPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include });
  if (!po) throw notFound("Purchase order");
  return {
    ...po,
    items: po.items.map((i) => ({ ...i, quantityPending: Math.max(0, i.quantityOrdered - i.quantityReceived) })),
  };
}

export async function listPurchaseOrders(q: z.infer<typeof poListQuery>, page: Pagination) {
  const where: Prisma.PurchaseOrderWhereInput = {
    status: q.status,
    supplierId: q.supplierId,
    number: q.q ? { contains: q.q.toUpperCase() } : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      include: { supplier: { select: { name: true, code: true } }, warehouse: { select: { code: true, name: true } }, items: { select: { quantityOrdered: true, quantityReceived: true } } },
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return {
    items: items.map(({ items: lines, ...po }) => ({
      ...po,
      quantityOrdered: lines.reduce((s, l) => s + l.quantityOrdered, 0),
      quantityReceived: lines.reduce((s, l) => s + l.quantityReceived, 0),
    })),
    meta: pageMeta(page, total),
  };
}
