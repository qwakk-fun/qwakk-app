/** Decimal places kept for prices written to PostgreSQL NUMERIC columns. */
export const PRICE_SCALE = 18;

function assertBaseAmount(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("Amounts must be non-negative integers");
}

function assertDecimals(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error("Decimals must be an integer between 0 and 36");
}

/** Formats a scaled integer as a plain decimal string without trailing zeros. */
function toDecimalString(scaled: bigint, scale: number) {
  const digits = scaled.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Converts a base-unit amount to display units, exactly. */
export function toDisplayUnits(amount: string, decimals: number) {
  assertBaseAmount(amount);
  assertDecimals(decimals);
  return toDecimalString(BigInt(amount), decimals);
}

/**
 * Price of token A expressed in token B, from one swap's base-unit amounts:
 * (amountB / 10^decimalsB) / (amountA / 10^decimalsA). Integer arithmetic only,
 * truncated to PRICE_SCALE decimals. Returns null when amount A is zero.
 */
export function priceBPerA(amountA: string, decimalsA: number, amountB: string, decimalsB: number) {
  assertBaseAmount(amountA);
  assertBaseAmount(amountB);
  assertDecimals(decimalsA);
  assertDecimals(decimalsB);
  if (BigInt(amountA) === BigInt(0)) return null;

  const ten = BigInt(10);
  const numerator = BigInt(amountB) * ten ** BigInt(decimalsA + PRICE_SCALE);
  const denominator = BigInt(amountA) * ten ** BigInt(decimalsB);
  return toDecimalString(numerator / denominator, PRICE_SCALE);
}
