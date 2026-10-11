/**
 * Normalises a phone number to E.164. Indian numbers may be entered as
 * 9876543210, 09876543210, 919876543210 or +91 98765 43210.
 * Returns null when the input is not a plausible number.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.replace(/[\s\-().]/g, "");
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^0[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(raw)) return `+${raw}`;
  if (/^\+91[6-9]\d{9}$/.test(raw)) return raw;
  if (/^\+[1-9]\d{7,14}$/.test(raw) && !raw.startsWith("+91")) return raw;
  return null;
}

export const isEmailLike = (value: string) => value.includes("@");

/** "+919876543210" -> "+91******3210" for logs and UI hints. */
export const maskPhone = (phone: string) => phone.replace(/^(\+\d{2})\d+(\d{4})$/, "$1******$2");
