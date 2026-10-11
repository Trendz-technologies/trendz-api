import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, withTransaction } from "../../database/prisma";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requireAnyPermission, requirePermission } from "../../common/guards/permissions";
import { conflict, notFound } from "../../common/errors/app-error";
import { created, ok, pageArgs, pageMeta, paginationQuery, uuidParam } from "../../common/utils/http";
import { stateCodeFor } from "../../common/utils/india";
import { audit, auditContext } from "../audit/audit.service";

export const suppliersRouter = Router();
suppliersRouter.use(authenticate, requireStaff);

const supplierSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().trim().min(2).max(120),
  companyName: z.string().trim().max(200).nullable().optional(),
  contactPerson: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  email: z.email().nullable().optional(),
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN").nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(12).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  paymentTerms: z.string().trim().max(300).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// Purchase-order authors pick suppliers, so they may list them without full supplier access.
suppliersRouter.get("/", requireAnyPermission("suppliers.read", "purchases.write"), async (req, res) => {
  const page = paginationQuery.parse(req.query);
  const { q, status } = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() }).parse(req.query);
  const where: Prisma.SupplierWhereInput = {
    status,
    OR: q
      ? [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q.toUpperCase() } }, { companyName: { contains: q, mode: "insensitive" } }, { gstin: { contains: q.toUpperCase() } }]
      : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: "asc" }, ...pageArgs(page), include: { _count: { select: { purchaseOrders: true } } } }),
    prisma.supplier.count({ where }),
  ]);
  ok(res, items.map(({ _count, ...s }) => ({ ...s, purchaseOrderCount: _count.purchaseOrders })), pageMeta(page, total));
});

suppliersRouter.get("/:id", requirePermission("suppliers.read"), async (req, res) => {
  const s = await prisma.supplier.findUnique({ where: { id: uuidParam.parse(req.params).id } });
  if (!s) throw notFound("Supplier");
  ok(res, s);
});

/** Purchase history with received vs pending quantities. */
suppliersRouter.get("/:id/purchase-history", requirePermission("suppliers.read"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const page = paginationQuery.parse(req.query);
  const where: Prisma.PurchaseOrderWhereInput = { supplierId: id };
  const [orders, total, totals] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      select: { id: true, number: true, status: true, orderDate: true, expectedDeliveryDate: true, grandTotal: true, items: { select: { quantityOrdered: true, quantityReceived: true } } },
    }),
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.aggregate({ where: { ...where, status: { notIn: ["DRAFT", "CANCELLED"] } }, _sum: { grandTotal: true }, _count: true }),
  ]);
  ok(
    res,
    orders.map(({ items, ...o }) => {
      const ordered = items.reduce((s, i) => s + i.quantityOrdered, 0);
      const received = items.reduce((s, i) => s + i.quantityReceived, 0);
      return { ...o, quantityOrdered: ordered, quantityReceived: received, quantityPending: Math.max(0, ordered - received) };
    }),
    { ...pageMeta(page, total), totalPurchased: totals._sum.grandTotal ?? 0, orderCount: totals._count },
  );
});

suppliersRouter.post("/", requirePermission("suppliers.write"), async (req, res) => {
  const input = supplierSchema.parse(req.body);
  if (await prisma.supplier.findUnique({ where: { code: input.code } })) throw conflict("A supplier with this code already exists");
  const s = await withTransaction(async (tx) => {
    const c = await tx.supplier.create({ data: { ...input, stateCode: input.state ? stateCodeFor(input.state) : null } });
    await audit(tx, auditContext(req), { action: "supplier.create", entityType: "supplier", entityId: c.id, newValue: c });
    return c;
  });
  created(res, s);
});

suppliersRouter.put("/:id", requirePermission("suppliers.write"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = supplierSchema.parse(req.body);
  const before = await prisma.supplier.findUnique({ where: { id } });
  if (!before) throw notFound("Supplier");
  if (input.code !== before.code && (await prisma.supplier.findUnique({ where: { code: input.code } }))) throw conflict("A supplier with this code already exists");
  const s = await withTransaction(async (tx) => {
    const u = await tx.supplier.update({ where: { id }, data: { ...input, stateCode: input.state ? stateCodeFor(input.state) : null } });
    await audit(tx, auditContext(req), { action: "supplier.update", entityType: "supplier", entityId: id, oldValue: before, newValue: u });
    return u;
  });
  ok(res, s);
});
