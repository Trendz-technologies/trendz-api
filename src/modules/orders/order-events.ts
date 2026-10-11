import { env } from "../../config/env";
import type { Db } from "../../database/prisma";
import { formatInr } from "../../common/utils/money";
import { createNotification } from "../notifications/notifications.service";
import { getSetting } from "../settings/settings.service";

export type OrderEvent =
  | { type: "confirmed" }
  | { type: "shipped"; courier?: string | null; awb?: string | null; trackingUrl?: string | null }
  | { type: "out_for_delivery" }
  | { type: "delivered" }
  | { type: "cancelled"; reason?: string | null; refundNote?: string | null }
  | { type: "refunded"; amount: number; refundNumber: string };

/**
 * Records customer (email, SMS, in-app) and admin notifications for an order
 * event inside the caller's transaction. Returns notification ids to dispatch
 * after commit. Idempotency keys make retried business operations safe.
 */
export async function orderEventNotifications(db: Db, orderId: string, event: OrderEvent): Promise<(string | null)[]> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { select: { productName: true, variantTitle: true, quantity: true, lineTotal: true } }, payments: { where: { status: "PAID" }, take: 1 } },
  });
  const ids: (string | null)[] = [];
  const key = (channel: string) => `order:${order.id}:${event.type}${"refundNumber" in event ? `:${event.refundNumber}` : ""}:${channel}`;
  const url = `${env.WEB_URL}/account/orders/${order.orderNumber}`;
  const email = order.customerEmail;
  const phone = order.customerPhone;

  const push = async (p: Promise<string | null>) => ids.push(await p);
  const smsOrder = (message: string) =>
    phone ? push(createNotification(db, { channel: "SMS", template: "ORDER", to: phone, variables: { order: order.orderNumber, message }, userId: order.userId, idempotencyKey: key("sms") })) : Promise.resolve();
  const inApp = (title: string, body: string) =>
    order.userId ? push(createNotification(db, { channel: "IN_APP", userId: order.userId, title, body, link: `/account/orders/${order.orderNumber}`, idempotencyKey: key("inapp") })) : Promise.resolve();

  switch (event.type) {
    case "confirmed": {
      if (email) {
        await push(
          createNotification(db, {
            channel: "EMAIL",
            template: "order.confirmed",
            to: email,
            userId: order.userId,
            idempotencyKey: key("email"),
            data: {
              name: order.customerName,
              orderNumber: order.orderNumber,
              grandTotal: order.grandTotal,
              url,
              items: order.items.map((i) => ({ name: i.productName, variant: i.variantTitle, quantity: i.quantity, total: i.lineTotal })),
            },
          }),
        );
        const payment = order.payments[0];
        if (payment && order.channel === "ONLINE") {
          await push(
            createNotification(db, {
              channel: "EMAIL",
              template: "order.payment_received",
              to: email,
              userId: order.userId,
              idempotencyKey: key("payment-email"),
              data: { orderNumber: order.orderNumber, amount: payment.amount, method: payment.method ?? payment.provider },
            }),
          );
        }
      }
      await smsOrder(`confirmed. Total ${formatInr(order.grandTotal)}`);
      await inApp(`Order ${order.orderNumber} confirmed`, `We have received your order of ${formatInr(order.grandTotal)}.`);
      const { adminEmails } = await getSetting("notifications");
      for (const to of adminEmails) {
        await push(
          createNotification(db, {
            channel: "EMAIL",
            template: "admin.new_order",
            to,
            idempotencyKey: `${key("admin")}:${to}`,
            data: { orderNumber: order.orderNumber, grandTotal: order.grandTotal, channel: order.channel, url: `${env.WEB_URL}/admin/orders/${order.id}` },
          }),
        );
      }
      break;
    }
    case "shipped":
      if (email) {
        await push(createNotification(db, { channel: "EMAIL", template: "order.shipped", to: email, userId: order.userId, idempotencyKey: key("email"), data: { orderNumber: order.orderNumber, courier: event.courier, awb: event.awb, trackingUrl: event.trackingUrl } }));
      }
      if (phone) {
        await push(
          createNotification(db, {
            channel: "SMS",
            template: "SHIPPING",
            to: phone,
            userId: order.userId,
            idempotencyKey: key("sms"),
            variables: { order: order.orderNumber, status: "shipped", url: event.trackingUrl ?? url },
          }),
        );
      }
      await inApp(`Order ${order.orderNumber} shipped`, event.awb ? `Tracking number ${event.awb}` : "Your order is on its way.");
      break;
    case "out_for_delivery":
      if (email) await push(createNotification(db, { channel: "EMAIL", template: "order.out_for_delivery", to: email, userId: order.userId, idempotencyKey: key("email"), data: { orderNumber: order.orderNumber } }));
      if (phone) await push(createNotification(db, { channel: "SMS", template: "SHIPPING", to: phone, userId: order.userId, idempotencyKey: key("sms"), variables: { order: order.orderNumber, status: "out for delivery", url } }));
      await inApp(`Order ${order.orderNumber} is out for delivery`, "It will reach you today.");
      break;
    case "delivered": {
      // Registered customers are invited to review what they received (the order page has the buttons).
      const invite = !!order.userId && (await getSetting("reviews")).enabled;
      if (email) await push(createNotification(db, { channel: "EMAIL", template: "order.delivered", to: email, userId: order.userId, idempotencyKey: key("email"), data: { orderNumber: order.orderNumber, reviewUrl: invite ? url : null } }));
      if (phone) await push(createNotification(db, { channel: "SMS", template: "SHIPPING", to: phone, userId: order.userId, idempotencyKey: key("sms"), variables: { order: order.orderNumber, status: "delivered", url } }));
      await inApp(`Order ${order.orderNumber} delivered`, invite ? "Enjoy your purchase! Tell us how you like it: rate and review your items." : "Enjoy your purchase!");
      break;
    }
    case "cancelled":
      if (email) {
        await push(createNotification(db, { channel: "EMAIL", template: "order.cancelled", to: email, userId: order.userId, idempotencyKey: key("email"), data: { orderNumber: order.orderNumber, reason: event.reason, refundNote: event.refundNote } }));
      }
      await smsOrder("cancelled" + (event.refundNote ? `. ${event.refundNote}` : ""));
      await inApp(`Order ${order.orderNumber} cancelled`, event.refundNote ?? event.reason ?? "Your order has been cancelled.");
      break;
    case "refunded":
      if (email) {
        await push(createNotification(db, { channel: "EMAIL", template: "order.refunded", to: email, userId: order.userId, idempotencyKey: key("email"), data: { orderNumber: order.orderNumber, amount: event.amount, refundNumber: event.refundNumber } }));
      }
      await smsOrder(`refund of ${formatInr(event.amount)} processed`);
      await inApp(`Refund processed`, `${formatInr(event.amount)} for order ${order.orderNumber}.`);
      break;
  }
  return ids;
}
