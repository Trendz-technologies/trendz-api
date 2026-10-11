import { Router, type Response } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { notFound } from "../../common/errors/app-error";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { prisma } from "../../database/prisma";
import { auditContext } from "../audit/audit.service";
import * as invoices from "./invoices.service";

export const invoicesRouter = Router();
invoicesRouter.use(authenticate, requireStaff);

const sendPdf = (res: Response, name: string, pdf: Buffer, download: boolean) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${name.replace(/\//g, "-")}.pdf"`);
  res.send(pdf);
};

invoicesRouter.get("/", requirePermission("invoices.read"), async (req, res) => {
  const q = z.object({ q: z.string().trim().max(50).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
  const { items, meta } = await invoices.listInvoices(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

/** Spec: POST /api/invoices/:orderId — issue (idempotent). */
invoicesRouter.post("/:orderId", requirePermission("invoices.write"), async (req, res) => {
  const { orderId } = z.object({ orderId: z.uuid() }).parse(req.params);
  created(res, await invoices.issueInvoice(orderId, auditContext(req)));
});

invoicesRouter.get("/:id", requirePermission("invoices.read"), async (req, res) => {
  ok(res, await invoices.getInvoice(uuidParam.parse(req.params).id));
});

invoicesRouter.get("/:id/pdf", requirePermission("invoices.read"), async (req, res) => {
  const inv = await invoices.getInvoice(uuidParam.parse(req.params).id);
  sendPdf(res, inv.invoiceNumber, await invoices.renderInvoicePdf(inv), req.query.download === "1");
});

export const creditNotesRouter = Router();
creditNotesRouter.use(authenticate, requireStaff);

creditNotesRouter.get("/", requirePermission("invoices.read"), async (req, res) => {
  const { items, meta } = await invoices.listCreditNotes(paginationQuery.parse(req.query));
  ok(res, items, meta);
});

creditNotesRouter.get("/:id/pdf", requirePermission("invoices.read"), async (req, res) => {
  const cn = await prisma.creditNote.findUnique({ where: { id: uuidParam.parse(req.params).id } });
  if (!cn) throw notFound("Credit note");
  sendPdf(res, cn.creditNoteNumber, await invoices.renderCreditNotePdf(cn), req.query.download === "1");
});
