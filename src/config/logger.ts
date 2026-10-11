import pino from "pino";
import { env, isProduction, isTest } from "./env";

// Structured JSON logs in production (collected by the host), pretty logs
// in development. Secrets and tokens are redacted wherever they may appear.
export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  base: { service: "trendz-api" },
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-csrf-token']",
      "res.headers['set-cookie']",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.otp",
      "*.razorpay_signature",
    ],
    censor: "[redacted]",
  },
  ...(isProduction || isTest
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }),
});

export type Logger = typeof logger;
