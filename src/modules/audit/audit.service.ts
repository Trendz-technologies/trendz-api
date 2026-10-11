import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma, type Db } from "../../database/prisma";
import { pageArgs, pageMeta, type Pagination } from "../../common/utils/http";

export interface AuditContext {
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export function auditContext(req: Request): AuditContext {
  return {
    userId: req.auth?.userId ?? null,
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
  };
}

export const systemContext: AuditContext = { userId: null, ipAddress: null, userAgent: "system" };

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

const json = (v: unknown) => (v === undefined || v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

/**
 * Appends an audit record. Pass the transaction client so the audit row is
 * committed (or rolled back) together with the change it describes.
 */
export async function audit(db: Db, ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      oldValue: json(entry.oldValue),
      newValue: json(entry.newValue),
    },
  });
}

export async function listAuditLogs(
  filter: { userId?: string; entityType?: string; entityId?: string; action?: string; from?: Date; to?: Date },
  page: Pagination,
) {
  const where: Prisma.AuditLogWhereInput = {
    userId: filter.userId,
    entityType: filter.entityType,
    entityId: filter.entityId,
    action: filter.action ? { startsWith: filter.action } : undefined,
    createdAt: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...pageArgs(page),
      include: { user: { select: { id: true, email: true, profile: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, meta: pageMeta(page, total) };
}
