import { Router } from "express";
import { z } from "zod";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { requirePermission } from "../../common/guards/permissions";
import { ok } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import { withAboutImage, withHomePictures } from "./cms";
import { withImageUrls } from "./home-offers";
import { SETTING_KEYS, type SettingKey, type Settings } from "./settings.schemas";
import { getSettingRecord, getSettings, updateSetting } from "./settings.service";

export const settingsRouter = Router();
settingsRouter.use(authenticate, requireStaff);

settingsRouter.get("/", requirePermission("settings.read"), async (_req, res) => ok(res, await getSettings()));

const keyParam = z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) });

// The home page and About us editors preview pictures, so those groups are returned with their addresses.
const present = (key: SettingKey, value: unknown) =>
  key === "homeOffers"
    ? withImageUrls(value as Settings["homeOffers"])
    : key === "homePage"
      ? withHomePictures(value as Settings["homePage"])
      : key === "aboutPage"
        ? withAboutImage(value as Settings["aboutPage"])
        : value;

settingsRouter.get("/:key", requirePermission("settings.read"), async (req, res) => {
  const record = await getSettingRecord(keyParam.parse(req.params).key);
  ok(res, { ...record, value: present(record.key, record.value) });
});

settingsRouter.put("/:key", requirePermission("settings.write"), async (req, res) => {
  const { key } = keyParam.parse(req.params);
  ok(res, present(key, await updateSetting(key, req.body, auditContext(req))));
});
