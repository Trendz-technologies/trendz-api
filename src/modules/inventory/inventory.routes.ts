import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as inventory from "./inventory.service";

export const inventoryRouter = Router();
inventoryRouter.use(authenticate, requireStaff);

inventoryRouter.get("/", requirePermission("inventory.read"), async (req, res) => {
  const { items, meta } = await inventory.listLevels(inventory.levelsQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

inventoryRouter.get("/low-stock", requirePermission("inventory.read"), async (_req, res) => ok(res, await inventory.lowStockVariants()));

inventoryRouter.get("/variants/:id", requirePermission("inventory.read"), async (req, res) => {
  ok(res, await inventory.variantStock(uuidParam.parse(req.params).id));
});

inventoryRouter.get("/transactions", requirePermission("inventory.read"), async (req, res) => {
  const { items, meta } = await inventory.listLedger(inventory.ledgerQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

inventoryRouter.post("/adjust", requirePermission("inventory.adjust"), async (req, res) => {
  created(res, await inventory.adjustStock(inventory.adjustSchema.parse(req.body), auditContext(req)));
});

inventoryRouter.get("/transfers", requirePermission("inventory.read"), async (req, res) => {
  const filter = z.object({ status: z.enum(["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(), warehouseId: z.uuid().optional() }).parse(req.query);
  const { items, meta } = await inventory.listTransfers(filter, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

// API.md: POST /inventory/transfer (spec) and /inventory/transfers (REST) both create a transfer.
const createTransfer: RequestHandler = async (req, res) => {
  created(res, await inventory.createTransfer(inventory.transferSchema.parse(req.body), auditContext(req)));
};
inventoryRouter.post("/transfers", requirePermission("inventory.transfer"), createTransfer);
inventoryRouter.post("/transfer", requirePermission("inventory.transfer"), createTransfer);

inventoryRouter.get("/transfers/:id", requirePermission("inventory.read"), async (req, res) => {
  ok(res, await inventory.getTransfer(uuidParam.parse(req.params).id));
});

inventoryRouter.post("/transfers/:id/dispatch", requirePermission("inventory.transfer"), async (req, res) => {
  ok(res, await inventory.dispatchTransfer(uuidParam.parse(req.params).id, auditContext(req)));
});

inventoryRouter.post("/transfers/:id/receive", requirePermission("inventory.transfer"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  ok(res, await inventory.receiveTransfer(id, inventory.receiveTransferSchema.parse(req.body ?? {}), auditContext(req)));
});

inventoryRouter.post("/transfers/:id/cancel", requirePermission("inventory.transfer"), async (req, res) => {
  ok(res, await inventory.cancelTransfer(uuidParam.parse(req.params).id, auditContext(req)));
});
