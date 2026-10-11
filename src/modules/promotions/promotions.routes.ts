import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { created, ok, paginationQuery, queryBool, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as coupons from "./coupons.service";
import * as discounts from "./discounts.service";

export const couponsRouter = Router();
couponsRouter.use(authenticate, requireStaff);

couponsRouter.get("/", requirePermission("coupons.read"), async (req, res) => {
  const q = z.object({ q: z.string().trim().toUpperCase().max(30).optional(), active: queryBool }).parse(req.query);
  const { items, meta } = await coupons.listCoupons(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});
couponsRouter.post("/", requirePermission("coupons.write"), async (req, res) => {
  created(res, await coupons.createCoupon(coupons.couponSchema.parse(req.body), auditContext(req)));
});
couponsRouter.get("/:id", requirePermission("coupons.read"), async (req, res) => ok(res, await coupons.getCoupon(uuidParam.parse(req.params).id)));
couponsRouter.put("/:id", requirePermission("coupons.write"), async (req, res) => {
  ok(res, await coupons.updateCoupon(uuidParam.parse(req.params).id, coupons.couponSchema.parse(req.body), auditContext(req)));
});
couponsRouter.delete("/:id", requirePermission("coupons.write"), async (req, res) => {
  ok(res, await coupons.deleteCoupon(uuidParam.parse(req.params).id, auditContext(req)));
});

export const discountsRouter = Router();
discountsRouter.use(authenticate, requireStaff);

discountsRouter.get("/", requirePermission("discounts.read"), async (req, res) => {
  const q = z.object({ active: queryBool }).parse(req.query);
  const { items, meta } = await discounts.listDiscounts(q, paginationQuery.parse(req.query));
  ok(res, items, meta);
});
discountsRouter.post("/", requirePermission("discounts.write"), async (req, res) => {
  created(res, await discounts.createDiscount(discounts.discountSchema.parse(req.body), auditContext(req)));
});
discountsRouter.get("/:id", requirePermission("discounts.read"), async (req, res) => ok(res, await discounts.getDiscount(uuidParam.parse(req.params).id)));
discountsRouter.put("/:id", requirePermission("discounts.write"), async (req, res) => {
  ok(res, await discounts.updateDiscount(uuidParam.parse(req.params).id, discounts.discountSchema.parse(req.body), auditContext(req)));
});
discountsRouter.delete("/:id", requirePermission("discounts.write"), async (req, res) => {
  await discounts.deleteDiscount(uuidParam.parse(req.params).id, auditContext(req));
  ok(res, { deleted: true });
});
