import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { idempotent } from "../../common/middleware/idempotency";
import { created, ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as pos from "./pos.service";
import { renderReceipt } from "./receipt";

export const posRouter = Router();
posRouter.use(authenticate, requireStaff, requirePermission("pos.use"));

const itemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

/** What the billing screen needs to render (cashiers do not have settings.read). */
posRouter.get("/config", async (_req, res) => ok(res, await pos.posConfig()));

posRouter.post("/carts", async (req, res) => {
  created(res, await pos.openCart(req.auth!, pos.openCartSchema.parse(req.body).warehouseId));
});

posRouter.get("/carts/:id", async (req, res) => ok(res, await pos.cartView(uuidParam.parse(req.params).id)));

posRouter.patch("/carts/:id", async (req, res) => {
  ok(res, await pos.patchCart(uuidParam.parse(req.params).id, pos.patchCartSchema.parse(req.body), req.auth!, auditContext(req)));
});

posRouter.post("/carts/:id/scan", async (req, res) => {
  ok(res, await pos.scan(uuidParam.parse(req.params).id, pos.scanSchema.parse(req.body), req.auth!, auditContext(req)));
});

posRouter.post("/carts/:id/items", async (req, res) => {
  ok(res, await pos.addItem(uuidParam.parse(req.params).id, pos.addItemSchema.parse(req.body), req.auth!, auditContext(req)));
});

posRouter.patch("/carts/:id/items/:itemId", async (req, res) => {
  const { id, itemId } = itemParams.parse(req.params);
  ok(res, await pos.updateItem(id, itemId, pos.updateItemSchema.parse(req.body), req.auth!, auditContext(req)));
});

posRouter.delete("/carts/:id/items/:itemId", async (req, res) => {
  const { id, itemId } = itemParams.parse(req.params);
  ok(res, await pos.removeItem(id, itemId, req.auth!));
});

posRouter.post("/carts/:id/checkout", idempotent("pos.checkout"), async (req, res) => {
  ok(res, await pos.checkout(uuidParam.parse(req.params).id, pos.checkoutSchema.parse(req.body), req.auth!, auditContext(req)));
});

posRouter.post("/carts/:id/abandon", async (req, res) => ok(res, await pos.abandonCart(uuidParam.parse(req.params).id, req.auth!)));

posRouter.get("/products/search", async (req, res) => {
  const { q, warehouseId } = z.object({ q: z.string().trim().min(2).max(60), warehouseId: z.uuid() }).parse(req.query);
  ok(res, await pos.searchProducts(q, warehouseId));
});

posRouter.get("/orders", async (req, res) => {
  const { warehouseId } = z.object({ warehouseId: z.uuid().optional() }).parse(req.query);
  const { items, meta } = await pos.recentSales(req.auth!, warehouseId, paginationQuery.parse(req.query));
  ok(res, items, meta);
});

posRouter.get("/orders/:id/receipt", async (req, res) => {
  const pdf = await renderReceipt(uuidParam.parse(req.params).id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=receipt.pdf");
  res.send(pdf);
});
