import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { isProduction } from "../../config/env";
import { logger } from "../../config/logger";
import { AppError } from "./app-error";

interface ErrorBody {
  success: false;
  message: string;
  code: string;
  errors: { path: string; message: string }[];
  requestId?: string;
  stack?: string;
}

function fromPrisma(err: Prisma.PrismaClientKnownRequestError): AppError | null {
  switch (err.code) {
    case "P2002": {
      const target = (err.meta?.target as string[] | string | undefined) ?? "field";
      const fields = Array.isArray(target) ? target.join(", ") : target;
      return new AppError(409, "CONFLICT", `A record with this ${fields} already exists`, [
        { path: fields, message: "must be unique" },
      ]);
    }
    case "P2025":
      return new AppError(404, "NOT_FOUND", "Resource not found");
    case "P2003":
      return new AppError(409, "CONFLICT", "This record is referenced by other records and cannot be changed");
    case "P2034":
      return new AppError(409, "CONFLICT", "The operation conflicted with a concurrent update. Please retry.");
    default:
      return null;
  }
}

/**
 * A GET that sends `X-Not-Found-Status: 200` gets "not found" as a 200; the
 * body is unchanged (success: false, code NOT_FOUND …).
 *
 * The storefront's server-side fetches use it. Their cache (Next.js) only
 * replaces a stored response with a 200 and serves the old copy until then,
 * so with a plain 404 a product or category that was deleted would stay on
 * the site indefinitely.
 */
const NOT_FOUND_STATUS_HEADER = "x-not-found-status";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError | null = null;

  if (err instanceof AppError) appError = err;
  else if (err instanceof ZodError) {
    appError = new AppError(
      400,
      "VALIDATION_ERROR",
      "Some fields are invalid",
      err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) appError = fromPrisma(err);
  else if (err?.type === "entity.parse.failed") appError = new AppError(400, "BAD_REQUEST", "Malformed JSON body");
  else if (err?.type === "entity.too.large") appError = new AppError(413, "PAYLOAD_TOO_LARGE", "Request body too large");

  const status = appError?.status ?? 500;
  const body: ErrorBody = {
    success: false,
    message: appError?.message ?? "Something went wrong. Please try again.",
    code: appError?.code ?? "INTERNAL_ERROR",
    errors: appError?.errors ?? [],
    requestId: req.id ? String(req.id) : undefined,
  };

  if (status >= 500) {
    logger.error({ err, requestId: req.id, path: req.path, method: req.method }, "unhandled error");
    if (!isProduction && err instanceof Error) body.stack = err.stack;
  }

  if (appError) for (const [k, v] of Object.entries(appError.headers)) res.setHeader(k, v);
  if (status === 404 && req.method === "GET" && req.get(NOT_FOUND_STATUS_HEADER) === "200") {
    // Only the caller that asked may keep this answer; browsers and proxies must not.
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(body);
    return;
  }
  res.status(status).json(body);
};
