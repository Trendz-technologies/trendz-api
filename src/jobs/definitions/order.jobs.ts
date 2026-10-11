import { QUEUE_NAMES } from "../queues";
import { registerJob, registerSchedule } from "../registry";
import { issueInvoice } from "../../modules/invoices/invoices.service";
import { expireUnpaidOrders, processWebhookEvent, reconcileOpenPayments } from "../../modules/payments/payments.service";

registerJob(QUEUE_NAMES.webhooks, "razorpay.process", async (job) => processWebhookEvent((job.data as { webhookEventId: string }).webhookEventId));

registerJob(QUEUE_NAMES.invoices, "invoice.issue", async (job) => {
  const invoice = await issueInvoice((job.data as { orderId: string }).orderId);
  return { invoiceNumber: invoice.invoiceNumber };
});

// Unpaid orders give their reserved stock back after the payment window.
registerJob(QUEUE_NAMES.maintenance, "orders.expire-unpaid", () => expireUnpaidOrders());
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "orders.expire-unpaid", every: 60_000 });

// Safety net for missed callbacks/webhooks.
registerJob(QUEUE_NAMES.maintenance, "payments.reconcile", () => reconcileOpenPayments());
registerSchedule({ queue: QUEUE_NAMES.maintenance, name: "payments.reconcile", every: 10 * 60_000 });
