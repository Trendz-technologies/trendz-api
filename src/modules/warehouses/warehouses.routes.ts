import { Router } from "express";
import { z } from "zod";
import { richText } from "../../common/utils/html";
import { prisma, withTransaction } from "../../database/prisma";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requireAnyPermission, requirePermission } from "../../common/guards/permissions";
import { badRequest, conflict, notFound } from "../../common/errors/app-error";
import { created, ok, uuidParam } from "../../common/utils/http";
import { isIndianPincode, stateCodeFor } from "../../common/utils/india";
import { audit, auditContext } from "../audit/audit.service";

export const warehousesRouter = Router();
warehousesRouter.use(authenticate, requireStaff);

const warehouseSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
    name: z.string().trim().min(2).max(100),
    addressLine1: z.string().trim().min(3).max(200),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    postalCode: z.string().trim(),
    contactName: z.string().trim().max(100).nullable().optional(),
    contactPhone: z.string().trim().max(20).nullable().optional(),
    contactEmail: z.email().nullable().optional(),
    gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN").nullable().optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
    isOnlineFulfillment: z.boolean().default(true),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .superRefine((w, ctx) => {
    if (!stateCodeFor(w.state)) ctx.addIssue({ code: "custom", path: ["state"], message: "Select a valid state" });
    if (!isIndianPincode(w.postalCode)) ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Enter a valid 6-digit PIN code" });
  });

const locationSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,30}$/),
  name: z.string().trim().max(100).nullable().optional(),
  description: richText(300),
  isActive: z.boolean().default(true),
});

warehousesRouter.get("/", requireAnyPermission("warehouses.read", "inventory.read", "pos.use"), async (_req, res) => {
  const rows = await prisma.warehouse.findMany({
    orderBy: [{ priority: "asc" }, { name: "asc" }],
    include: { _count: { select: { locations: true } } },
  });
  const stock = await prisma.inventoryLevel.groupBy({ by: ["warehouseId"], _sum: { onHand: true, reserved: true } });
  ok(
    res,
    rows.map(({ _count, ...w }) => {
      const s = stock.find((x) => x.warehouseId === w.id);
      return { ...w, locationCount: _count.locations, onHand: s?._sum.onHand ?? 0, reserved: s?._sum.reserved ?? 0 };
    }),
  );
});

warehousesRouter.get("/:id", requireAnyPermission("warehouses.read", "inventory.read"), async (req, res) => {
  const w = await prisma.warehouse.findUnique({ where: { id: uuidParam.parse(req.params).id }, include: { locations: { orderBy: { code: "asc" } } } });
  if (!w) throw notFound("Warehouse");
  ok(res, w);
});

warehousesRouter.post("/", requirePermission("warehouses.write"), async (req, res) => {
  const input = warehouseSchema.parse(req.body);
  if (await prisma.warehouse.findUnique({ where: { code: input.code } })) throw conflict("A warehouse with this code already exists");
  const w = await withTransaction(async (tx) => {
    const created = await tx.warehouse.create({ data: { ...input, stateCode: stateCodeFor(input.state)! } });
    await audit(tx, auditContext(req), { action: "warehouse.create", entityType: "warehouse", entityId: created.id, newValue: created });
    return created;
  });
  created(res, w);
});

warehousesRouter.put("/:id", requirePermission("warehouses.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = warehouseSchema.parse(req.body);
  const before = await prisma.warehouse.findUnique({ where: { id } });
  if (!before) throw notFound("Warehouse");
  if (input.code !== before.code && (await prisma.warehouse.findUnique({ where: { code: input.code } }))) throw conflict("A warehouse with this code already exists");
  if (input.status === "INACTIVE" && before.status === "ACTIVE") {
    const reserved = await prisma.inventoryLevel.aggregate({ where: { warehouseId: id }, _sum: { reserved: true } });
    if ((reserved._sum.reserved ?? 0) > 0) throw badRequest("This warehouse has stock reserved for open orders. Fulfil or cancel them first.");
  }
  const w = await withTransaction(async (tx) => {
    const updated = await tx.warehouse.update({ where: { id }, data: { ...input, stateCode: stateCodeFor(input.state)! } });
    await audit(tx, auditContext(req), { action: "warehouse.update", entityType: "warehouse", entityId: id, oldValue: before, newValue: updated });
    return updated;
  });
  ok(res, w);
});

warehousesRouter.get("/:id/locations", requireAnyPermission("warehouses.read", "inventory.read"), async (req, res) => {
  ok(res, await prisma.warehouseLocation.findMany({ where: { warehouseId: uuidParam.parse(req.params).id }, orderBy: { code: "asc" } }));
});

warehousesRouter.post("/:id/locations", requirePermission("warehouses.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = locationSchema.parse(req.body);
  if (!(await prisma.warehouse.findUnique({ where: { id } }))) throw notFound("Warehouse");
  created(res, await prisma.warehouseLocation.create({ data: { ...input, warehouseId: id } }));
});

warehousesRouter.put("/:id/locations/:locationId", requirePermission("warehouses.write"), async (req, res) => {
  const { id, locationId } = z.object({ id: z.uuid(), locationId: z.uuid() }).parse(req.params);
  const input = locationSchema.parse(req.body);
  const loc = await prisma.warehouseLocation.findFirst({ where: { id: locationId, warehouseId: id } });
  if (!loc) throw notFound("Location");
  ok(res, await prisma.warehouseLocation.update({ where: { id: locationId }, data: input }));
});

warehousesRouter.delete("/:id/locations/:locationId", requirePermission("warehouses.write"), async (req, res) => {
  const { id, locationId } = z.object({ id: z.uuid(), locationId: z.uuid() }).parse(req.params);
  const res2 = await prisma.warehouseLocation.deleteMany({ where: { id: locationId, warehouseId: id } });
  if (!res2.count) throw notFound("Location");
  ok(res, { deleted: true });
});
