import crypto from "node:crypto";

export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export const hmacSha256Hex = (secret: string, value: string) =>
  crypto.createHmac("sha256", secret).update(value).digest("hex");

/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** Constant-time comparison of two strings (returns false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Uniform random numeric code, e.g. an OTP. */
export function randomDigits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

const ALPHANUM = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I to avoid misreads on labels

/** Random code from an unambiguous alphabet (for QR identifiers, coupon codes...). */
export function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHANUM[crypto.randomInt(0, ALPHANUM.length)];
  return out;
}

/** Stable hash of a JSON-serialisable value (key order independent). */
export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
