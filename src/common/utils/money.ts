/**
 * Money helpers. All amounts are integer paise; all rates are basis points.
 * Rounding is "half away from zero" to the nearest paisa, applied once per
 * computed amount (never on intermediate floats that are stored).
 */

export const BPS_DENOMINATOR = 10_000;

export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** amount * bps / 10000, rounded to the nearest paisa. */
export function applyBps(amount: number, bps: number): number {
  return roundHalfUp((amount * bps) / BPS_DENOMINATOR);
}

/** Tax contained in a tax-inclusive amount: amount * rate / (1 + rate). */
export function inclusiveTax(amountInclTax: number, rateBps: number): number {
  if (rateBps === 0) return 0;
  return roundHalfUp((amountInclTax * rateBps) / (BPS_DENOMINATOR + rateBps));
}

/** Splits an integer amount proportionally to weights; the parts always sum to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map((r) => Math.floor(r));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  // Largest-remainder method: hand out leftover paise to the biggest fractions.
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floored[i]! += 1;
    remainder -= 1;
  }
  return floored;
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

export const formatInr = (paise: number) => inr.format(paise / 100);
export const rupeesToPaise = (rupees: number) => roundHalfUp(rupees * 100);
export const formatBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
