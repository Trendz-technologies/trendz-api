/** GS1 check digit for EAN-13 (12 data digits) and UPC-A (11 data digits). */
export function gs1CheckDigit(data: string): number {
  // Weights alternate 3,1 starting from the rightmost data digit.
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const digit = Number(data[data.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && gs1CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function isValidUpcA(code: string): boolean {
  return /^\d{12}$/.test(code) && gs1CheckDigit(code.slice(0, 11)) === Number(code[11]);
}

/** Code 128 B covers printable ASCII; keep values short enough for small labels. */
export function isValidCode128(code: string): boolean {
  return /^[\x20-\x7E]{1,48}$/.test(code);
}

export function buildEan13(prefix: string, sequence: number): string {
  const body = prefix + String(sequence).padStart(12 - prefix.length, "0");
  if (body.length !== 12) throw new Error(`EAN-13 sequence overflow for prefix ${prefix}`);
  return body + gs1CheckDigit(body);
}

/** UPC-A with number system 2 (reserved for in-store / variable-measure use). */
export function buildUpcA(sequence: number): string {
  const body = "2" + String(sequence).padStart(10, "0");
  if (body.length !== 11) throw new Error("UPC-A sequence overflow");
  return body + gs1CheckDigit(body);
}

export interface QrPayload {
  type: "PRODUCT";
  sku: string;
  id: string; // the public code value, never an internal database id
}

export const buildQrPayload = (sku: string, codeValue: string) => JSON.stringify({ type: "PRODUCT", sku, id: codeValue } satisfies QrPayload);

/**
 * Normalises whatever a scanner produced into lookup candidates.
 * Accepts raw code values, SKUs and the JSON QR payload. Trims the control
 * characters that some USB scanners append.
 */
export function parseScannedInput(raw: string): { codeValue: string | null; sku: string | null } {
  // USB scanners may append CR/LF/TAB or other control characters.
  // eslint-disable-next-line no-control-regex
  const input = raw.replace(/[\r\n\t\u0000-\u001f]/g, "").trim();
  if (input.startsWith("{")) {
    try {
      const parsed = JSON.parse(input) as Partial<QrPayload>;
      return { codeValue: typeof parsed.id === "string" ? parsed.id : null, sku: typeof parsed.sku === "string" ? parsed.sku.toUpperCase() : null };
    } catch {
      // fall through: treat as a plain code
    }
  }
  return { codeValue: input, sku: input.toUpperCase() };
}
