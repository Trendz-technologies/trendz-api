import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { notFound } from "../../common/errors/app-error";
import { ok, pageArgs, pageMeta, paginationQuery, uuidParam } from "../../common/utils/http";

export const customersRouter = Router();
customersRouter.use(authenticate, requireStaff, requirePermission("customers.read"));

customersRouter.get("/", async (req, res) => {
  const page = paginationQuery.parse(req.query);
  const { q } = z.object({ q: z.string().trim().max(100).optional() }).parse(req.query);
  const where: Prisma.UserWhereInput = {
    isStaff: false,
    OR: q
      ? [
          { email: { contains: q, mode: "insensitive" } },
          { phone: { contains: q } },
          { profile: { firstName: { contains: q, mode: "insensitive" } } },
          { profile: { lastName: { contains: q, mode: "insensitive" } } },
        ]
      : undefined,
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      select: { id: true, email: true, phone: true, status: true, createdAt: true, lastLoginAt: true, profile: { select: { firstName: true, lastName: true } } },
    }),
    prisma.user.count({ where }),
  ]);
  const stats = await prisma.order.groupBy({
    by: ["userId"],
    where: { userId: { in: users.map((u) => u.id) }, paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } },
    _count: true,
    _sum: { grandTotal: true, amountRefunded: true },
    _max: { placedAt: true },
  });
  ok(
    res,
    users.map((u) => {
      const s = stats.find((x) => x.userId === u.id);
      return { ...u, orders: s?._count ?? 0, spent: (s?._sum.grandTotal ?? 0) - (s?._sum.amountRefunded ?? 0), lastOrderAt: s?._max.placedAt ?? null };
    }),
    pageMeta(page, total),
  );
});

customersRouter.get("/:id", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const user = await prisma.user.findFirst({
    where: { id, isStaff: false },
    select: {
      id: true,
      email: true,
      phone: true,
      status: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      createdAt: true,
      lastLoginAt: true,
      profile: true,
      addresses: true,
      orders: { orderBy: { placedAt: "desc" }, take: 20, select: { id: true, orderNumber: true, status: true, paymentStatus: true, grandTotal: true, placedAt: true, channel: true } },
      returnRequests: { orderBy: { createdAt: "desc" }, take: 10, select: { id: true, returnNumber: true, status: true, createdAt: true } },
    },
  });
  if (!user) throw notFound("Customer");
  const totals = await prisma.order.aggregate({ where: { userId: id, paymentStatus: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] } }, _count: true, _sum: { grandTotal: true, amountRefunded: true } });
  ok(res, { ...user, stats: { orders: totals._count, spent: (totals._sum.grandTotal ?? 0) - (totals._sum.amountRefunded ?? 0) } });
});
