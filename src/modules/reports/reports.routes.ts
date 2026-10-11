import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { forbidden } from "../../common/errors/app-error";
import { ok } from "../../common/utils/http";
import { audit, auditContext } from "../audit/audit.service";
import { prisma } from "../../database/prisma";
import { dashboardCharts, dashboardSummary } from "./dashboard.service";
import { REPORT_TYPES, reportQuery, runReport, toCsv, toPdf, toXlsx } from "./reports.service";

export const dashboardRouter = Router();
dashboardRouter.use(authenticate, requireStaff, requirePermission("dashboard.read"));
dashboardRouter.get("/summary", async (_req, res) => ok(res, await dashboardSummary()));
dashboardRouter.get("/charts", async (req, res) => {
  const { range } = z.object({ range: z.enum(["7d", "30d", "90d", "12m"]).default("30d") }).parse(req.query);
  ok(res, await dashboardCharts(range));
});

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireStaff, requirePermission("reports.read"));

reportsRouter.get("/", (_req, res) => ok(res, REPORT_TYPES));

reportsRouter.get("/:type", async (req, res) => {
  const { type } = z.object({ type: z.enum(REPORT_TYPES) }).parse(req.params);
  const q = reportQuery.parse(req.query);
  const report = await runReport(type, q);
  if (q.format === "json") return ok(res, report);

  if (!req.auth!.permissions.includes("reports.export")) throw forbidden("Exporting reports requires the reports.export permission");
  await audit(prisma, auditContext(req), { action: "report.export", entityType: "report", entityId: type, newValue: { format: q.format, from: report.period.from, to: report.period.to, rows: report.rows.length } });
  const name = `${type}-${report.period.from.slice(0, 10)}-to-${report.period.to.slice(0, 10)}`;
  if (q.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    return res.send(toCsv(report));
  }
  if (q.format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.xlsx"`);
    return res.send(await toXlsx(report));
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`);
  res.send(await toPdf(report));
});
