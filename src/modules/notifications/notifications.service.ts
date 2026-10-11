import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { logger } from "../../config/logger";
import { prisma, type Db } from "../../database/prisma";
import { enqueue, QUEUE_NAMES } from "../../jobs/queues";
import { emailProvider, type EmailAttachment } from "../../integrations/email";
import { isEmailTemplate, renderEmail, type EmailTemplate, type EmailTemplateData } from "../../integrations/email/templates";
import { maskForLog, renderSmsText, smsProvider, type SmsTemplate } from "../../integrations/sms";
import { getSetting } from "../settings/settings.service";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { notFound } from "../../common/errors/app-error";

/** Attachments are referenced, not stored; they are rendered at send time. */
export type AttachmentRef = { kind: "invoice"; invoiceId: string } | { kind: "credit_note"; creditNoteId: string };

type AttachmentResolver = (ref: AttachmentRef) => Promise<EmailAttachment>;
const attachmentResolvers = new Map<AttachmentRef["kind"], AttachmentResolver>();

/** Modules that can produce attachments (e.g. invoices) register a resolver. */
export function registerAttachmentResolver(kind: AttachmentRef["kind"], resolver: AttachmentResolver) {
  attachmentResolvers.set(kind, resolver);
}

export type NotificationInput =
  | {
      [K in EmailTemplate]: {
        channel: "EMAIL";
        template: K;
        to: string;
        data: EmailTemplateData[K];
        attachments?: AttachmentRef[];
        userId?: string | null;
        idempotencyKey?: string;
      };
    }[EmailTemplate]
  | {
      channel: "SMS";
      template: SmsTemplate;
      to: string;
      variables: Record<string, string>;
      userId?: string | null;
      idempotencyKey?: string;
    }
  | {
      channel: "IN_APP";
      userId: string;
      title: string;
      body: string;
      link?: string;
      idempotencyKey?: string;
    };

const MAX_ATTEMPTS = 6;

/**
 * Records a notification (transactional outbox). Call inside the business
 * transaction, then `dispatchNotifications(ids)` after commit. Duplicate
 * idempotency keys are ignored, so retried business operations never send
 * twice. Returns null when the channel is disabled in settings.
 */
export async function createNotification(db: Db, input: NotificationInput): Promise<string | null> {
  const flags = await getSetting("notifications");
  if (input.channel === "EMAIL" && !flags.emailEnabled) return null;
  if (input.channel === "SMS" && !flags.smsEnabled) return null;

  // Every row gets a key so it can be found again after ON CONFLICT DO NOTHING.
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const base = {
    channel: input.channel,
    userId: input.userId ?? null,
    idempotencyKey,
  } as const;

  const data: Prisma.NotificationCreateManyInput =
    input.channel === "EMAIL"
      ? {
          ...base,
          template: input.template,
          recipient: input.to,
          payload: { data: input.data, attachments: input.attachments ?? [] } as Prisma.InputJsonValue,
        }
      : input.channel === "SMS"
        ? { ...base, template: input.template, recipient: input.to, payload: { variables: input.variables } }
        : {
            ...base,
            template: "in_app",
            title: input.title,
            body: input.body,
            payload: { link: input.link ?? null },
            status: "SENT",
            sentAt: new Date(),
          };

  // ON CONFLICT DO NOTHING keeps the surrounding transaction valid on duplicates.
  await db.notification.createMany({ data: [data], skipDuplicates: true });
  const row = await db.notification.findUnique({ where: { idempotencyKey }, select: { id: true, status: true } });
  return row && row.status === "PENDING" ? row.id : null;
}

export async function dispatchNotifications(ids: (string | null | undefined)[]): Promise<void> {
  await Promise.all(
    ids
      .filter((id): id is string => !!id)
      .map((id) => enqueue(QUEUE_NAMES.notifications, "deliver", { notificationId: id }, { jobId: `notif-${id}` })),
  );
}

/** Convenience for code that is not inside a transaction. */
export async function notify(input: NotificationInput): Promise<void> {
  const id = await createNotification(prisma, input);
  await dispatchNotifications([id]);
}

/** Worker: deliver one notification. Throws to trigger a BullMQ retry. */
export async function deliverNotification(notificationId: string): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.status !== "PENDING") return; // already sent / permanently failed / unknown

  const payload = (n.payload ?? {}) as Record<string, unknown>;
  try {
    if (n.channel === "EMAIL") {
      if (!isEmailTemplate(n.template)) throw new Error(`Unknown email template ${n.template}`);
      const rendered = renderEmail(n.template, payload.data as never);
      const refs = (payload.attachments as AttachmentRef[] | undefined) ?? [];
      const attachments = await Promise.all(
        refs.map((ref) => {
          const resolver = attachmentResolvers.get(ref.kind);
          if (!resolver) throw new Error(`No attachment resolver for ${ref.kind}`);
          return resolver(ref);
        }),
      );
      const provider = emailProvider();
      const result = await provider.send({ to: n.recipient!, ...rendered, attachments });
      await prisma.$transaction([
        prisma.notification.update({
          where: { id: n.id },
          data: { status: "SENT", sentAt: new Date(), subject: rendered.subject, attempts: { increment: 1 }, providerMessageId: result.messageId },
        }),
        prisma.emailLog.create({
          data: { notificationId: n.id, to: n.recipient!, subject: rendered.subject, template: n.template, provider: provider.name, providerMessageId: result.messageId, status: "SENT" },
        }),
      ]);
    } else if (n.channel === "SMS") {
      const variables = (payload.variables ?? {}) as Record<string, string>;
      const template = n.template as SmsTemplate;
      const text = renderSmsText(template, variables);
      const provider = smsProvider();
      const result = await provider.send({ to: n.recipient!, template, variables, text });
      await prisma.$transaction([
        prisma.notification.update({
          where: { id: n.id },
          data: { status: "SENT", sentAt: new Date(), body: text, attempts: { increment: 1 }, providerMessageId: result.messageId },
        }),
        prisma.smsLog.create({
          data: { notificationId: n.id, phone: n.recipient!, template, body: maskForLog(template, text, variables), provider: provider.name, providerMessageId: result.messageId, status: "SENT" },
        }),
      ]);
    } else {
      await prisma.notification.update({ where: { id: n.id }, data: { status: "SENT", sentAt: new Date() } });
    }
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    const attempts = n.attempts + 1;
    const final = attempts >= MAX_ATTEMPTS;
    await prisma.notification.update({
      where: { id: n.id },
      data: { attempts, lastError: message, status: final ? "FAILED" : "PENDING" },
    });
    if (n.channel === "EMAIL") {
      await prisma.emailLog.create({ data: { notificationId: n.id, to: n.recipient ?? "", subject: n.subject ?? n.template, template: n.template, provider: emailProvider().name, status: "FAILED", error: message } });
    } else if (n.channel === "SMS") {
      await prisma.smsLog.create({ data: { notificationId: n.id, phone: n.recipient ?? "", template: n.template, body: "(not sent)", provider: smsProvider().name, status: "FAILED", error: message } });
    }
    logger.warn({ notificationId: n.id, attempts, final, err: message }, "notification delivery failed");
    if (!final) throw err;
  }
}

/** Re-queues PENDING notifications whose job was lost (crash between commit and enqueue). */
export async function sweepPendingNotifications(): Promise<number> {
  const stale = await prisma.notification.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 2 * 60_000) } },
    select: { id: true, attempts: true },
    take: 200,
  });
  await Promise.all(
    stale.map((s) =>
      enqueue(QUEUE_NAMES.notifications, "deliver", { notificationId: s.id }, { jobId: `notif-${s.id}-sweep-${s.attempts}` }),
    ),
  );
  return stale.length;
}

/** Admin: retry a FAILED notification. */
export async function retryNotification(id: string): Promise<void> {
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n) throw notFound("Notification");
  await prisma.notification.update({ where: { id }, data: { status: "PENDING", attempts: 0, lastError: null } });
  await enqueue(QUEUE_NAMES.notifications, "deliver", { notificationId: id }, { jobId: `notif-${id}-retry-${Date.now()}` });
}

// ---------------------------------------------------------------------------
// Secret-bearing messages (OTP codes, password-reset and verification links)
// are never written to PostgreSQL. They travel only in a short-lived Redis job
// that is deleted as soon as it completes; the delivery log stores no secret.
// ---------------------------------------------------------------------------

export interface TransientEmailJob {
  kind: "email";
  template: EmailTemplate;
  to: string;
  data: unknown;
}
export interface TransientSmsJob {
  kind: "sms";
  template: SmsTemplate;
  to: string;
  variables: Record<string, string>;
}

const TRANSIENT_OPTS = { removeOnComplete: true, removeOnFail: { age: 3600 }, attempts: 4, backoff: { type: "exponential", delay: 2_000 } };

export function sendTransientEmail<K extends EmailTemplate>(template: K, to: string, data: EmailTemplateData[K]) {
  return enqueue(QUEUE_NAMES.notifications, "transient", { kind: "email", template, to, data } satisfies TransientEmailJob, {
    ...TRANSIENT_OPTS,
    priority: 1,
  });
}

export function sendTransientSms(template: SmsTemplate, to: string, variables: Record<string, string>) {
  return enqueue(QUEUE_NAMES.notifications, "transient", { kind: "sms", template, to, variables } satisfies TransientSmsJob, {
    ...TRANSIENT_OPTS,
    priority: 1,
  });
}

export async function deliverTransient(job: TransientEmailJob | TransientSmsJob): Promise<void> {
  if (job.kind === "email") {
    const rendered = renderEmail(job.template, job.data as never);
    const provider = emailProvider();
    try {
      const r = await provider.send({ to: job.to, ...rendered });
      await prisma.emailLog.create({ data: { to: job.to, subject: rendered.subject, template: job.template, provider: provider.name, providerMessageId: r.messageId, status: "SENT" } });
    } catch (err) {
      await prisma.emailLog.create({ data: { to: job.to, subject: rendered.subject, template: job.template, provider: provider.name, status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
      throw err;
    }
  } else {
    const text = renderSmsText(job.template, job.variables);
    const provider = smsProvider();
    try {
      const r = await provider.send({ to: job.to, template: job.template, variables: job.variables, text });
      await prisma.smsLog.create({ data: { phone: job.to, template: job.template, body: maskForLog(job.template, text, job.variables), provider: provider.name, providerMessageId: r.messageId, status: "SENT" } });
    } catch (err) {
      await prisma.smsLog.create({ data: { phone: job.to, template: job.template, body: maskForLog(job.template, text, job.variables), provider: provider.name, status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listNotifications(
  filter: { channel?: "EMAIL" | "SMS" | "IN_APP"; status?: "PENDING" | "SENT" | "FAILED"; userId?: string },
  page: Pagination,
) {
  const where: Prisma.NotificationWhereInput = { channel: filter.channel, status: filter.status, userId: filter.userId };
  const [items, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      select: { id: true, channel: true, template: true, recipient: true, subject: true, title: true, status: true, attempts: true, lastError: true, sentAt: true, createdAt: true, userId: true },
    }),
    prisma.notification.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}

export async function listInApp(userId: string, page: Pagination) {
  const where: Prisma.NotificationWhereInput = { userId, channel: "IN_APP" };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      select: { id: true, title: true, body: true, payload: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  return { items, meta: { ...pageMeta(page, total), unread } };
}

export async function markRead(userId: string, id: string) {
  const res = await prisma.notification.updateMany({ where: { id, userId, channel: "IN_APP" }, data: { readAt: new Date() } });
  if (res.count === 0) throw notFound("Notification");
}
