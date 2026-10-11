import type { Principal } from "../modules/auth/principal";

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user, set by the `authenticate` middleware. */
      auth?: Principal;
      /** How the request was authenticated (cookie auth is CSRF-checked). */
      authMethod?: "cookie" | "bearer";
      /** Raw request body, kept for webhook signature verification. */
      rawBody?: Buffer;
    }
  }
}

export {};
