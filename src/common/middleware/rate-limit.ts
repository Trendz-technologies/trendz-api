import type { Request, RequestHandler } from "express";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { cacheRedis, markRedisFailure, redisAvailable } from "../../database/redis";
import { tooManyRequests } from "../errors/app-error";

interface LimitOptions {
  /** Unique name, used as the Redis key prefix. */
  name: string;
  /** Allowed requests per window. */
  points: number;
  /** Window length in seconds. */
  durationSeconds: number;
  /** Block for this long once exhausted (defaults to the window). */
  blockSeconds?: number;
  /** Key extractor; defaults to client IP. Return null to skip limiting. */
  key?: (req: Request) => string | null;
  message?: string;
}

function makeLimiter(o: LimitOptions) {
  // If Redis is unavailable the in-memory limiter keeps protecting this node.
  const insurance = new RateLimiterMemory({ points: o.points, duration: o.durationSeconds, blockDuration: o.blockSeconds ?? 0 });
  const shared = new RateLimiterRedis({
    storeClient: cacheRedis,
    keyPrefix: `rl:${o.name}`,
    points: o.points,
    duration: o.durationSeconds,
    blockDuration: o.blockSeconds ?? 0,
    insuranceLimiter: insurance,
  });
  return {
    async consume(key: string) {
      // While the Redis circuit breaker is open, skip straight to the in-memory limiter.
      if (!redisAvailable()) return insurance.consume(key);
      const started = Date.now();
      const result = await shared.consume(key);
      // The Redis limiter silently falls back to insurance on errors; a slow answer means Redis is struggling.
      if (Date.now() - started > 1000) markRedisFailure(new Error("slow rate-limit call"), `rate limit ${o.name}`);
      return result;
    },
    delete: (key: string) => Promise.all([shared.delete(key).catch(() => false), insurance.delete(key)]).then(() => true),
  };
}

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown";

export function rateLimit(o: LimitOptions): RequestHandler {
  const limiter = makeLimiter(o);
  return async (req, res, next) => {
    const key = o.key ? o.key(req) : clientIp(req);
    if (key === null) return next();
    try {
      const r = await limiter.consume(key);
      res.setHeader("RateLimit-Remaining", String(r.remainingPoints));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        throw tooManyRequests(o.message ?? "Too many requests. Please slow down.", err.msBeforeNext / 1000);
      }
      throw err;
    }
  };
}

/**
 * Imperative limiter for use inside services (e.g. per-phone OTP limits,
 * where the key comes from the validated body).
 */
export function createLimiter(o: Omit<LimitOptions, "key">) {
  const limiter = makeLimiter(o);
  return {
    async consume(key: string) {
      try {
        await limiter.consume(key);
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          throw tooManyRequests(o.message ?? "Too many attempts. Please try again later.", err.msBeforeNext / 1000);
        }
        throw err;
      }
    },
    reset: (key: string) => limiter.delete(key),
  };
}

// Shared limiters used across routes.
export const publicApiLimit = rateLimit({ name: "public", points: 300, durationSeconds: 60 });
