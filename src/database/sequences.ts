import type { Tx } from "./prisma";

/**
 * Returns the next value of a gap-free sequence. Must be called inside the same
 * transaction that creates the numbered document: the row lock is held until
 * commit, and a rollback also rolls the counter back, so numbers never skip.
 */
export async function nextSequenceValue(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next_value: number }[]>`
    INSERT INTO document_sequences (key, next_value, updated_at)
    VALUES (${key}, 2, now())
    ON CONFLICT (key) DO UPDATE
      SET next_value = document_sequences.next_value + 1, updated_at = now()
    RETURNING next_value - 1 AS next_value`;
  return Number(rows[0]!.next_value);
}

/** Indian financial year label (April–March), e.g. 2026-27. */
export function financialYear(date = new Date()): string {
  const istDate = toIst(date);
  const year = istDate.getUTCFullYear();
  const start = istDate.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** YYYYMMDD in India Standard Time. */
export function istDateStamp(date = new Date()): string {
  const d = toIst(date);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

function toIst(date: Date): Date {
  return new Date(date.getTime() + 330 * 60_000);
}

export const pad = (n: number, width = 4) => String(n).padStart(width, "0");

/** ORD-20261008-0001 — resets daily. */
export async function nextOrderNumber(tx: Tx, prefix = "ORD"): Promise<string> {
  const stamp = istDateStamp();
  const n = await nextSequenceValue(tx, `${prefix}:${stamp}`);
  return `${prefix}-${stamp}-${pad(n)}`;
}

/**
 * Financial-year document numbers, e.g. INV/2627/000123 for FY 2026-27.
 * GST invoice numbers must be at most 16 characters (letters, digits, - and /),
 * so the FY is written as 4 digits and prefixes are limited to 4 characters.
 */
export async function nextFinancialYearNumber(tx: Tx, prefix: string, opts: { width?: number; separator?: "/" | "-" } = {}): Promise<string> {
  const fy = financialYear();
  const n = await nextSequenceValue(tx, `${prefix}:${fy}`);
  const sep = opts.separator ?? "/";
  const fyShort = fy.replace(/^20(\d{2})-(\d{2})$/, "$1$2"); // 2026-27 -> 2627
  return [prefix, fyShort, pad(n, opts.width ?? 6)].join(sep);
}

/** PO-2026-0001 style numbers that reset yearly. */
export async function nextYearlyNumber(tx: Tx, prefix: string): Promise<string> {
  const year = toIst(new Date()).getUTCFullYear();
  const n = await nextSequenceValue(tx, `${prefix}:${year}`);
  return `${prefix}-${year}-${pad(n)}`;
}
