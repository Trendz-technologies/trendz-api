import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { rateLimit } from "../../common/middleware/rate-limit";
import { forbidden, notFound } from "../../common/errors/app-error";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { prisma } from "../../database/prisma";
import { auditContext } from "../audit/audit.service";
import { renderInvoicePdf } from "../invoices/invoices.service";
import { getSetting } from "../settings/settings.service";
import * as orders from "./orders.service";

const checkoutLimit = rateLimit({ name: "checkout", points: 30, durationSeconds: 600, key: (req) => req.auth?.userId ?? req.ip ?? null, message: "Too many checkout attempts. Please wait a few minutes." });

/** POST /api/checkout/quote */
export const checkoutRouter = Router();
checkoutRouter.use(authenticate);
checkoutRouter.post("/quote", async (req, res) => {
  ok(res, await orders.checkoutQuote(req.auth!.userId, orders.quoteSchema.parse(req.body)));
});

/** /api/orders — customers place orders; staff manage them. */
export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.post("/", checkoutLimit, idempotent("orders.create"), async (req, res) => {
  const { allowGuestCheckout } = await getSetting("checkout");
  if (!req.auth && !allowGuestCheckout) throw forbidden("Please sign in to place an order");
  const input = orders.placeOrderSchema.parse(req.body);
  created(res, await orders.placeOnlineOrder(req.auth!.userId, input, req.get("idempotency-key")!));
});

ordersRouter.get("/", requireStaff, requirePermission("orders.read"), async (req, res) => {
  const { items, meta } = await orders.listOrders(orders.orderListQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

ordersRouter.get("/:id", requireStaff, requirePermission("orders.read"), async (req, res) => {
  ok(res, await orders.getOrderForStaff(uuidParam.parse(req.params).id));
});

ordersRouter.patch("/:id/status", requireStaff, requirePermission("orders.update"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status, note } = orders.statusUpdateSchema.parse(req.body);
  ok(res, await orders.updateStatusByStaff(id, status, note, auditContext(req)));
});

ordersRouter.post("/:id/cancel", requireStaff, requirePermission("orders.cancel"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const { refundError } = await orders.cancelOrder(id, { reason, actor: auditContext(req), by: "staff" });
  ok(res, { ...(await orders.getOrderForStaff(id)), refundError });
});

/** Customer self-service order routes, mounted on /api/account. */
export const accountOrdersRouter = Router();
accountOrdersRouter.use(authenticate);

accountOrdersRouter.get("/orders", async (req, res) => {
  const { items, meta } = await orders.listCustomerOrders(req.auth!.userId, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

accountOrdersRouter.get("/orders/:orderNumber", async (req, res) => {
  const { orderNumber } = z.object({ orderNumber: z.string().max(40) }).parse(req.params);
  ok(res, await orders.getOrderForCustomer(req.auth!.userId, orderNumber));
});

accountOrdersRouter.post("/orders/:orderNumber/cancel", async (req, res) => {
  const { orderNumber } = z.object({ orderNumber: z.string().max(40) }).parse(req.params);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const order = await prisma.order.findFirst({ where: { orderNumber, userId: req.auth!.userId }, select: { id: true } });
  if (!order) throw notFound("Order");
  await orders.cancelOrder(order.id, { reason, actor: auditContext(req), by: "customer", customerId: req.auth!.userId });
  ok(res, await orders.getOrderForCustomer(req.auth!.userId, orderNumber));
});

accountOrdersRouter.get("/orders/:orderNumber/invoice.pdf", async (req, res) => {
  const { orderNumber } = z.object({ orderNumber: z.string().max(40) }).parse(req.params);
  const order = await prisma.order.findFirst({ where: { orderNumber, userId: req.auth!.userId }, select: { invoice: true } });
  if (!order?.invoice) throw notFound("Invoice");
  const pdf = await renderInvoicePdf(order.invoice);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${order.invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`);
  res.send(pdf);
});
