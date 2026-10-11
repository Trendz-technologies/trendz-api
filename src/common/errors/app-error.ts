export interface FieldError {
  path: string;
  message: string;
}

/**
 * An expected, client-facing error. Anything that is not an AppError is
 * treated as an internal error and its details are never sent to clients.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly errors: FieldError[] = [],
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST", errors: FieldError[] = []) =>
  new AppError(400, code, message, errors);
export const unauthenticated = (message = "Authentication required", code = "UNAUTHENTICATED") =>
  new AppError(401, code, message);
export const forbidden = (message = "You do not have permission to perform this action", code = "FORBIDDEN") =>
  new AppError(403, code, message);
export const notFound = (what = "Resource", code = "NOT_FOUND") => new AppError(404, code, `${what} not found`);
export const conflict = (message: string, code = "CONFLICT") => new AppError(409, code, message);
export const unprocessable = (message: string, code = "UNPROCESSABLE") => new AppError(422, code, message);
export const invalidState = (message: string) => new AppError(409, "INVALID_STATE", message);
export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new AppError(429, "RATE_LIMITED", message, [], { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) });
