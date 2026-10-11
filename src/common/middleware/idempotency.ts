import type { RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { logger } from "../../config/logger";
import { AppError, badRequest, conflict } from "../errors/app-error";
import { hashJson } from "../utils/crypto";
import { clientIp } from "./rate-limit";

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RETENTION_HOURS = 24;

/**
 * Makes a POST endpoint safe to retry. The first request with a given
 * `Idempotency-Key` runs normally and its successful response is stored; any
 * retry with the same key and body gets the stored response instead of
 * running again. Reusing a key with a different body is rejected.
 *
 * Only 2xx responses are stored — failed attempts can be retried with the same
 * key. Business tables also carry UNIQUE constraints as a second line of defence.
 */
export function idempotent(routeName: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.get("idempotency-key");
    if (!key || !KEY_PATTERN.test(key)) {
      throw badRequest("An Idempotency-Key header (8-128 characters) is required", "IDEMPOTENCY_KEY_REQUIRED");
    }
    const scope = `${req.auth?.userId ?? clientIp(req)}:${routeName}`;
    const requestHash = hashJson({ params: req.params, body: req.body ?? null });

    try {
      await prisma.idempotencyKey.create({
        data: {
          scope,
          key,
          requestHash,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 3600_000),
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
      if (!existing) throw conflict("Request is being processed, retry shortly", "IDEMPOTENCY_IN_PROGRESS");
      if (existing.requestHash !== requestHash) {
        throw conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_CONFLICT");
      }
      if (existing.status === "IN_PROGRESS") {
        throw new AppError(409, "IDEMPOTENCY_IN_PROGRESS", "This request is already being processed");
      }
      res.setHeader("Idempotent-Replay", "true");
      res.status(existing.responseCode ?? 200).json(existing.responseBody);
      return;
    }

    let body: unknown;
    const json = res.json.bind(res);
    res.json = (b: unknown) => {
      body = b;
      return json(b);
    };

    res.on("finish", () => {
      const done =
        res.statusCode >= 200 && res.statusCode < 300
          ? prisma.idempotencyKey.update({
              where: { scope_key: { scope, key } },
              data: {
                status: "COMPLETED",
                responseCode: res.statusCode,
                responseBody: (body ?? null) as Prisma.InputJsonValue,
              },
            })
          : prisma.idempotencyKey.delete({ where: { scope_key: { scope, key } } });
      done.catch((err: unknown) => logger.error({ err, scope, key }, "failed to finalise idempotency key"));
    });

    next();
  };
}
