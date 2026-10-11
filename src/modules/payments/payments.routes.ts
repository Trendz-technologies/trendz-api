import { Router, type Request } from "express";
import { z } from "zod";
import { isProduction } from "../../config/env";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { can, requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { rateLimit } from "../../common/middleware/rate-limit";
import { notFound } from "../../common/errors/app-error";
import { ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { prisma } from "../../database/prisma";
import { mockGateway } from "../../integrations/razorpay";
import { auditContext } from "../audit/audit.service";
import * as payments from "./payments.service";

export const paymentsRouter = Router();

const paymentLimit = rateLimit({ name: "payment-create", points: 20, durationSeconds: 600, key: (req) => req.auth?.userId ?? req.ip ?? null });

const actorOf = (req: Request): payments.PaymentActor => ({
  userId: req.auth!.userId,
  isStaffAllowed: !!req.auth!.isStaff && (can(req.auth!.permissions, "pos.use") || can(req.auth!.permissions, "payments.manage")),
});

/** Razorpay webhook: no session, verified by HMAC signature over the raw body. */
paymentsRouter.post("/webhook", async (req, res) => {
  const result = await payments.ingestWebhook(req.rawBody, req.get("x-razorpay-signature"), req.get("x-razorpay-event-id"));
  ok(res, result);
});

paymentsRouter.post("/create", authenticate, paymentLimit, idempotent("payments.create"), async (req, res) => {
  const { orderId } = z.object({ orderId: z.uuid() }).parse(req.body);
  ok(res, await payments.createPaymentForOrder(orderId, actorOf(req)));
});

paymentsRouter.post("/verify", authenticate, paymentLimit, async (req, res) => {
  ok(res, await payments.verifyCheckout(payments.verifySchema.parse(req.body), actorOf(req)));
});

/**
 * DEVELOPMENT ONLY: stands in for the Razorpay checkout popup when
 * PAYMENT_PROVIDER=mock. Returns what Razorpay's handler would receive and
 * also delivers a signed webhook through the real webhook pipeline.
 */
if (!isProduction) {
  paymentsRouter.post("/mock/complete", authenticate, async (req, res) => {
    const gateway = mockGateway();
    if (!gateway) throw notFound("Route");
    const { razorpayOrderId, outcome } = z.object({ razorpayOrderId: z.string(), outcome: z.enum(["success", "failure"]).default("success") }).parse(req.body);
    const payment = await prisma.payment.findUnique({ where: { razorpayOrderId }, include: { order: { select: { userId: true } } } });
    if (!payment || (payment.order.userId !== req.auth!.userId && !actorOf(req).isStaffAllowed)) throw notFound("Payment");
    const sim = await gateway.simulateCheckout(razorpayOrderId, outcome);
    const hook = gateway.signedWebhook(outcome === "success" ? "payment.captured" : "payment.failed", sim.payment);
    await payments.ingestWebhook(hook.body, hook.signature, hook.eventId);
    ok(res, { checkoutResponse: sim.checkoutResponse, error: outcome === "failure" ? { description: sim.payment.errorDescription } : null });
  });
}

paymentsRouter.get("/", authenticate, requireStaff, requirePermission("payments.read"), async (req, res) => {
  const { items, meta } = await payments.listPayments(payments.paymentListQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

paymentsRouter.get("/:id", authenticate, requireStaff, requirePermission("payments.read"), async (req, res) => {
  ok(res, await payments.getPayment(uuidParam.parse(req.params).id));
});

paymentsRouter.post("/:id/reconcile", authenticate, requireStaff, requirePermission("payments.manage"), async (req, res) => {
  ok(res, await payments.reconcilePayment(uuidParam.parse(req.params).id, auditContext(req)));
});
