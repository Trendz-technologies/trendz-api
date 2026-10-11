import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type Db } from "../../database/prisma";
import { cached, invalidate } from "../../database/redis";
import { audit, type AuditContext } from "../audit/audit.service";
import { checkAttachedImages } from "../media/upload-limit";
import { settingSchemas, SETTING_KEYS, type SettingKey, type Settings } from "./settings.schemas";

// The cached copy is only good for the version of the settings that wrote it: a release that adds a
// field would otherwise read a copy without it (and without its default) until the cache expired. The
// key therefore carries a fingerprint of every setting's defaults, which changes whenever one is added.
export const SETTINGS_CACHE_KEY = `settings:all:${createHash("sha1")
  .update(JSON.stringify(SETTING_KEYS.map((key) => settingSchemas[key].parse({}))))
  .digest("hex")
  .slice(0, 10)}`;
const CACHE_TTL_SECONDS = 300;

async function loadAll(db: Db = prisma): Promise<Settings> {
  const rows = await db.setting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) {
    // Stored values are merged over defaults, so new fields get sane defaults.
    const parsed = settingSchemas[key].safeParse(byKey.get(key) ?? {});
    out[key] = parsed.success ? parsed.data : settingSchemas[key].parse({});
  }
  return out as Settings;
}

export async function getSettings(): Promise<Settings> {
  const settings = await cached(SETTINGS_CACHE_KEY, CACHE_TTL_SECONDS, () => loadAll());
  // Right after a release that adds a settings group, the cached copy (written by the previous
  // version) does not have it yet. Read from the database instead of handing out `undefined`.
  if (SETTING_KEYS.every((key) => settings[key] !== undefined)) return settings;
  await invalidate(SETTINGS_CACHE_KEY);
  return loadAll();
}

export async function getSetting<K extends SettingKey>(key: K): Promise<Settings[K]> {
  return (await getSettings())[key];
}

/** One setting with who last saved it and when (null until it is first saved). */
export async function getSettingRecord<K extends SettingKey>(key: K) {
  const row = await prisma.setting.findUnique({ where: { key } });
  const parsed = settingSchemas[key].safeParse(row?.value ?? {});
  const user = row?.updatedById
    ? await prisma.user.findUnique({ where: { id: row.updatedById }, select: { email: true, profile: { select: { firstName: true, lastName: true } } } })
    : null;
  return {
    key,
    value: (parsed.success ? parsed.data : settingSchemas[key].parse({})) as Settings[K],
    updatedAt: row?.updatedAt ?? null,
    updatedBy: user ? [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" ") || user.email : null,
  };
}

/** Uncached read for use inside money/stock transactions. */
export async function getSettingFresh<K extends SettingKey>(db: Db, key: K): Promise<Settings[K]> {
  const row = await db.setting.findUnique({ where: { key } });
  return settingSchemas[key].parse(row?.value ?? {}) as Settings[K];
}

/** Storage keys of the pictures a content setting shows (none for every other setting). */
function pictureKeys<K extends SettingKey>(key: K, value: Settings[K]): string[] {
  const keys =
    key === "homePage"
      ? [(value as Settings["homePage"]).logo.imageKey, (value as Settings["homePage"]).hero.imageKey]
      : key === "homeOffers"
        ? (value as Settings["homeOffers"]).cards.map((card) => card.imageKey)
        : key === "aboutPage"
          ? [(value as Settings["aboutPage"]).imageKey]
          : [];
  return keys.filter((k): k is string => !!k);
}

export async function updateSetting<K extends SettingKey>(
  key: K,
  value: unknown,
  ctx: AuditContext,
): Promise<Settings[K]> {
  const parsed = settingSchemas[key].parse(value) as Settings[K];
  // A picture this save attaches was uploaded straight to storage: hold it to the upload limit before it goes live.
  const pictures = pictureKeys(key, parsed);
  if (pictures.length) await checkAttachedImages(pictures, pictureKeys(key, await getSetting(key)));
  await prisma.$transaction(async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    await tx.setting.upsert({
      where: { key },
      create: { key, value: parsed as Prisma.InputJsonValue, updatedById: ctx.userId },
      update: { value: parsed as Prisma.InputJsonValue, updatedById: ctx.userId },
    });
    await audit(tx, ctx, { action: "settings.update", entityType: "setting", entityId: key, oldValue: before?.value, newValue: parsed });
  });
  await invalidate(SETTINGS_CACHE_KEY);
  return parsed;
}
