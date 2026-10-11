import { Router } from "express";
import { z } from "zod";
import { ok } from "../../common/utils/http";
import { rateLimit } from "../../common/middleware/rate-limit";
import { onLogin } from "../auth/auth.routes";
import * as cart from "./cart.service";

export const cartRouter = Router();

onLogin((req, res, userId) => cart.mergeGuestCart(req, res, userId));

const couponLimit = rateLimit({ name: "coupon", points: 20, durationSeconds: 300, message: "Too many coupon attempts. Try again in a few minutes." });

cartRouter.get("/", async (req, res) => {
  ok(res, await cart.cartView(await cart.resolveCart(req, res, false)));
});

cartRouter.post("/items", async (req, res) => {
  const { variantId, quantity } = cart.addItemSchema.parse(req.body);
  const c = (await cart.resolveCart(req, res, true))!;
  await cart.addItem(c, variantId, quantity);
  ok(res, await cart.cartView(c));
});

cartRouter.patch("/items/:itemId", async (req, res) => {
  const { itemId } = z.object({ itemId: z.uuid() }).parse(req.params);
  const { quantity } = cart.updateItemSchema.parse(req.body);
  const c = await cart.resolveCart(req, res, false);
  if (c) await cart.updateItem(c, itemId, quantity);
  ok(res, await cart.cartView(c));
});

cartRouter.delete("/items/:itemId", async (req, res) => {
  const { itemId } = z.object({ itemId: z.uuid() }).parse(req.params);
  const c = await cart.resolveCart(req, res, false);
  if (c) await cart.removeItem(c, itemId);
  ok(res, await cart.cartView(c));
});

cartRouter.delete("/", async (req, res) => {
  const c = await cart.resolveCart(req, res, false);
  if (c) await cart.clearCart(c.id);
  ok(res, await cart.cartView(c ? { ...c, couponCode: null } : null));
});

cartRouter.post("/coupon", couponLimit, async (req, res) => {
  const { code } = cart.couponSchema.parse(req.body);
  const c = (await cart.resolveCart(req, res, true))!;
  await cart.applyCoupon(c, code);
  ok(res, await cart.cartView({ ...c, couponCode: code.toUpperCase() }));
});

cartRouter.delete("/coupon", async (req, res) => {
  const c = await cart.resolveCart(req, res, false);
  if (c) await cart.removeCoupon(c);
  ok(res, await cart.cartView(c ? { ...c, couponCode: null } : null));
});
