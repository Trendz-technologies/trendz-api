import { Router } from "express";
import { authenticate } from "../../common/middleware/authenticate";
import { ok, created, paginationQuery, uuidParam } from "../../common/utils/http";
import * as account from "./account.service";
import { listInApp, markRead } from "../notifications/notifications.service";
import { listSessions, revokeSession } from "../auth/sessions";
import { prisma } from "../../database/prisma";

/** Customer self-service. Order, return and wishlist routes are added by their modules. */
export const accountRouter = Router();
accountRouter.use(authenticate);

accountRouter.get("/profile", async (req, res) => ok(res, await account.getProfile(req.auth!.userId)));

accountRouter.patch("/profile", async (req, res) => {
  const input = account.profileUpdateSchema.parse(req.body);
  ok(res, await account.updateProfile(req.auth!.userId, input));
});

accountRouter.get("/addresses", async (req, res) => ok(res, await account.listAddresses(req.auth!.userId)));

accountRouter.post("/addresses", async (req, res) => {
  const input = account.addressSchema.parse(req.body);
  created(res, await account.createAddress(req.auth!.userId, input));
});

accountRouter.patch("/addresses/:id", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const input = account.addressSchema.parse(req.body);
  ok(res, await account.updateAddress(req.auth!.userId, id, input));
});

accountRouter.delete("/addresses/:id", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  await account.deleteAddress(req.auth!.userId, id);
  ok(res, { deleted: true });
});

accountRouter.get("/notifications", async (req, res) => {
  const page = paginationQuery.parse(req.query);
  const { items, meta } = await listInApp(req.auth!.userId, page);
  ok(res, items, meta);
});

accountRouter.post("/notifications/:id/read", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  await markRead(req.auth!.userId, id);
  ok(res, { read: true });
});

accountRouter.get("/sessions", async (req, res) => ok(res, await listSessions(req.auth!.userId, req.auth!.sessionId)));

accountRouter.delete("/sessions/:id", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const owned = await prisma.userSession.findFirst({ where: { id, userId: req.auth!.userId }, select: { id: true } });
  if (owned) await revokeSession(id, "revoked by user");
  ok(res, { revoked: !!owned });
});
