import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Request } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { csrfProtection } from "./common/middleware/csrf";
import { optionalAuth } from "./common/middleware/authenticate";
import { errorHandler, notFoundHandler } from "./common/errors/error-handler";
import { apiRouter } from "./routes";

/** Endpoints whose signature is computed over the exact raw bytes. */
const RAW_BODY_PATHS = ["/api/payments/webhook", "/api/shipping/webhook"];

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind the host's proxies in production (TRUST_PROXY says how many); makes req.ip the real client IP.
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith("/api/health") ?? false },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      // The API only serves JSON / files; the web app sets its own CSP.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
      hsts: env.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  const allowedOrigins = new Set([env.WEB_URL, ...(env.CORS_ORIGINS?.split(",").map((o) => o.trim()) ?? [])]);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token", "Idempotency-Key", "X-Client", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "Retry-After", "Idempotent-Replay"],
      maxAge: 600,
    }),
  );
  app.use(compression());
  app.use(
    express.json({
      limit: "1mb",
      verify: (req: IncomingMessage, _res, buf) => {
        if (RAW_BODY_PATHS.some((p) => req.url?.startsWith(p))) (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(cookieParser());
  app.use(csrfProtection);
  app.use(optionalAuth);

  app.use("/api", apiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
