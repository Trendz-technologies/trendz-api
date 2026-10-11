import argon2 from "argon2";
import { z } from "zod";

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations).
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Password must contain letters and numbers");

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Used when the account does not exist so response timing does not reveal it.
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHash ??= argon2.hash("timing-equaliser-password-1", OPTIONS);
  await verifyPassword(await dummyHash, plain);
}
