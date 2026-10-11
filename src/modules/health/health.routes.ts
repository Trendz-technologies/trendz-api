import { Router } from "express";
import { prisma } from "../../database/prisma";
import { redis } from "../../database/redis";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.json({ success: true, data: { status: "ok", uptimeSeconds: Math.round(process.uptime()) } });
});

healthRouter.get("/ready", async (_req, res) => {
  const checks = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
  const [db, cache] = checks.map((c) => c.status === "fulfilled");
  const ready = db && cache;
  res.status(ready ? 200 : 503).json({ success: ready, data: { database: db ? "up" : "down", redis: cache ? "up" : "down" } });
});
