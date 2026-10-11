import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { ok, pageArgs, pageMeta, paginationQuery, uuidParam } from "../../common/utils/http";
import { normalizePhone } from "../../common/utils/phone";
import { badRequest } from "../../common/errors/app-error";
import { audit, auditContext } from "../audit/audit.service";
import { listNotifications, notify, retryNotification } from "./notifications.service";
import { getSetting } from "../settings/settings.service";

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, requireStaff);

notificationsRouter.get("/", requirePermission("notifications.read"), async (req, res) => {
  const q = z.object({ channel: z.enum(["EMAIL", "SMS", "IN_APP"]).optional(), status: z.enum(["PENDING", "SENT", "FAILED"]).optional() }).parse(req.query);
  const { items, meta } = await listNotifications(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

notificationsRouter.post("/:id/retry", requirePermission("notifications.manage"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  await retryNotification(id);
  await audit(prisma, auditContext(req), { action: "notification.retry", entityType: "notification", entityId: id });
  ok(res, { queued: true });
});

notificationsRouter.post("/test", requirePermission("notifications.manage"), async (req, res) => {
  const { channel, to } = z.object({ channel: z.enum(["EMAIL", "SMS"]), to: z.string().trim().min(5).max(200) }).parse(req.body);
  const flags = await getSetting("notifications");
  if ((channel === "EMAIL" && !flags.emailEnabled) || (channel === "SMS" && !flags.smsEnabled)) {
    throw badRequest(`${channel === "EMAIL" ? "Email" : "SMS"} notifications are turned off in Settings → Notifications. Turn them on to send a test.`, "CHANNEL_DISABLED");
  }
  if (channel === "EMAIL") {
    await notify({ channel: "EMAIL", template: "system.test", to: z.email().parse(to), data: { sentAt: new Date().toISOString() } });
  } else {
    const phone = normalizePhone(to);
    if (!phone) throw badRequest("Enter a valid mobile number");
    await notify({ channel: "SMS", template: "ORDER", to: phone, variables: { order: "TEST", message: "test message from your store" } });
  }
  ok(res, { queued: true });
});

export const smsLogsRouter = Router();
smsLogsRouter.use(authenticate, requireStaff, requirePermission("notifications.read"));
smsLogsRouter.get("/", async (req, res) => {
  const page = paginationQuery.parse(req.query);
  const { q } = z.object({ q: z.string().trim().max(20).optional() }).parse(req.query);
  const where: Prisma.SmsLogWhereInput = q ? { phone: { contains: q } } : {};
  const [items, total] = await Promise.all([prisma.smsLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page) }), prisma.smsLog.count({ where })]);
  ok(res, items, pageMeta(page, total));
});

export const emailLogsRouter = Router();
emailLogsRouter.use(authenticate, requireStaff, requirePermission("notifications.read"));
emailLogsRouter.get("/", async (req, res) => {
  const page = paginationQuery.parse(req.query);
  const { q } = z.object({ q: z.string().trim().max(200).optional() }).parse(req.query);
  const where: Prisma.EmailLogWhereInput = q ? { to: { contains: q, mode: "insensitive" } } : {};
  const [items, total] = await Promise.all([prisma.emailLog.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(page) }), prisma.emailLog.count({ where })]);
  ok(res, items, pageMeta(page, total));
});
