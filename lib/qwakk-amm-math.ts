/**
 * Integer AMM math for QoreChain's native x/amm, in base units only.
 *
 * The chain keeper is closed source (`x/amm/keeper_stub.go` is a no-op stub in
 * the public build). What is public: pools are "constant-product
 * (Uniswap-V2-style)" (qorechain-core CHANGELOG v2.23.0), all math is integer
 * `math.Int` (same entry), the swap fee is `swap_fee_bps` and
 * `max_swap_impact_bps` "caps the slippage allowed in a single swap relative to
 * the pre-swap mid-price" (`x/amm/types/params.go`).
 *
 * Qwakk prices swaps from the chain's own `QuoteExactIn`. This module is the
 * fallback estimate, the impact guard and the oracle the tests and the
 * launch-day verifier (`scripts/qwakk-verify-amm.ts`) compare the chain with.
 * Every rounding choice below is the one that is worse for the trader, so an
 * estimate never promises more than the chain can deliver.
 */

export const BPS = BigInt(10_000);
const ZERO = BigInt(0);
const ONE = BigInt(1);

function int(value: string | bigint, name: string) {
  if (typeof value === "bigint") {
    if (value < ZERO) throw new Error(`${name} must not be negative`);
    return value;
  }
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function bps(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`${name} must be between 0 and 10000 bps`);
  return BigInt(value);
}

export function ceilDiv(numerator: bigint, denominator: bigint) {
  if (denominator <= ZERO) throw new Error("Division by zero");
  return (numerator + denominator - ONE) / denominator;
}

/** Floor square root of a non-negative integer (Newton iteration, exact). */
export function isqrt(value: bigint) {
  if (value < ZERO) throw new Error("Square root of a negative number");
  if (value < BigInt(2)) return value;
  let x = value;
  let y = (x + ONE) / BigInt(2);
  while (y < x) {
    x = y;
    y = (x + value / x) / BigInt(2);
  }
  return x;
}

export type ConstantProductQuote = {
  /** Output the trader receives, rounded down. */
  amountOut: string;
  /** Swap fee taken from the input, rounded up. */
  fee: string;
};

/**
 * Exact-in output of an x*y=k pool with the fee taken from the input:
 * `out = floor(reserveOut * inAfterFee / (reserveIn + inAfterFee))`, with the
 * fee rounded up. This is the Uniswap V2 rule the chain names; if the keeper
 * rounds the fee down instead, it pays out at most one unit more.
 */
export function constantProductOut(amountIn: string | bigint, reserveIn: string | bigint, reserveOut: string | bigint, swapFeeBps: number): ConstantProductQuote {
  const input = int(amountIn, "Amount in");
  const rIn = int(reserveIn, "Reserve in");
  const rOut = int(reserveOut, "Reserve out");
  const feeBps = bps(swapFeeBps, "Swap fee");
  if (input === ZERO || rIn === ZERO || rOut === ZERO) return { amountOut: "0", fee: "0" };
  const fee = ceilDiv(input * feeBps, BPS);
  const inAfterFee = input - fee;
  const amountOut = (rOut * inAfterFee) / (rIn + inAfterFee);
  return { amountOut: amountOut.toString(), fee: fee.toString() };
}

/**
 * Exact-out input of an x*y=k pool: the smallest input that pays out exactly
 * `amountOut`, with the swap fee taken from the input.
 * `inAfterFee = ceil(reserveIn * out / (reserveOut - out))`,
 * `amountIn = ceil(inAfterFee * 10000 / (10000 - swapFeeBps))`,
 * `fee = amountIn - inAfterFee`. This reproduces QoreChain Diana's own
 * `QuoteExactOut` to the unit (pool 2, 2026-11-19: 10 fUSD out quoted
 * 230624132 uqor in with fee 691873; 10 QOR out quoted 446588 fUSD base units
 * in with fee 1340). Null when the pool cannot pay out that much.
 */
export function constantProductIn(amountOut: string | bigint, reserveIn: string | bigint, reserveOut: string | bigint, swapFeeBps: number): { amountIn: string; fee: string } | null {
  const output = int(amountOut, "Amount out");
  const rIn = int(reserveIn, "Reserve in");
  const rOut = int(reserveOut, "Reserve out");
  const feeBps = bps(swapFeeBps, "Swap fee");
  if (output === ZERO || rIn === ZERO || output >= rOut || feeBps === BPS) return null;
  const inAfterFee = ceilDiv(rIn * output, rOut - output);
  const amountIn = ceilDiv(inAfterFee * BPS, BPS - feeBps);
  return { amountIn: amountIn.toString(), fee: (amountIn - inAfterFee).toString() };
}

/**
 * Price impact in bps: how much worse the effective price `out / in` is than
 * the pre-swap mid price `reserveOut / reserveIn`, rounded up. The swap fee is
 * part of the effective price, so this is never lower than the chain's own
 * measure of impact, whether or not the chain counts the fee.
 */
export function priceImpactBps(amountIn: string | bigint, amountOut: string | bigint, reserveIn: string | bigint, reserveOut: string | bigint) {
  const input = int(amountIn, "Amount in");
  const output = int(amountOut, "Amount out");
  const rIn = int(reserveIn, "Reserve in");
  const rOut = int(reserveOut, "Reserve out");
  if (input === ZERO || rIn === ZERO || rOut === ZERO) return 10_000;
  const ideal = input * rOut;
  const actual = output * rIn;
  if (actual >= ideal) return 0;
  const impact = ceilDiv((ideal - actual) * BPS, ideal);
  return Number(impact > BPS ? BPS : impact);
}

/**
 * How far a swap moves the price along the pool curve, in bps rounded to the
 * nearest: the pre-fee execution price against the pre-swap mid price,
 * `1 - rIn / (rIn + inAfterFee)`. This is the price impact the trader is
 * shown. Unlike `priceImpactBps` it leaves out the swap fee (shown on its own
 * line) and the pool's rounding of a tiny output down to whole base units:
 * neither moves the price, and on a 99-unit output the rounding alone reads
 * as a 0.7% "impact". `priceImpactBps` stays the conservative cap guard.
 */
export function curveImpactBps(amountInAfterFee: string | bigint, reserveIn: string | bigint) {
  const input = int(amountInAfterFee, "Amount in after fee");
  const rIn = int(reserveIn, "Reserve in");
  if (rIn === ZERO) return 10_000;
  const total = rIn + input;
  const impact = (input * BPS * BigInt(2) + total) / (BigInt(2) * total);
  return Number(impact > BPS ? BPS : impact);
}

/**
 * The largest swap input (after the interface fee) whose fee-inclusive price
 * impact stays within `capBps` on an x*y=k pool. From
 * `1 - rIn(1-f) / (rIn + in(1-f)) <= c`:
 * `in <= rIn * (c - f) / ((1 - c)(1 - f))`, in bps and rounded down.
 * Zero when the fee alone reaches the cap. Null when the chain sets no cap.
 */
export function maxSwapInForImpact(reserveIn: string | bigint, reserveOut: string | bigint, capBps: number, swapFeeBps: number) {
  const rIn = int(reserveIn, "Reserve in");
  const rOut = int(reserveOut, "Reserve out");
  const cap = bps(capBps, "Impact cap");
  const fee = bps(swapFeeBps, "Swap fee");
  if (cap === ZERO || cap === BPS) return null;
  if (cap <= fee || rIn === ZERO || rOut === ZERO) return ZERO;
  let max = (rIn * (cap - fee) * BPS) / ((BPS - cap) * (BPS - fee));
  // The closed form ignores the pool's integer rounding of the output; step
  // down until the rounded result is within the cap.
  while (max > ZERO && priceImpactBps(max, constantProductOut(max, rIn, rOut, swapFeeBps).amountOut, rIn, rOut) > capBps) {
    max -= max / BigInt(1_000) + ONE;
  }
  return max;
}

/** Interface fee on a total input, rounded down (in the trader's favour). */
export function interfaceFeeFor(totalAmountIn: string | bigint, feeBps: number) {
  return (int(totalAmountIn, "Amount in") * bps(feeBps, "Interface fee")) / BPS;
}

/**
 * The largest total input whose swap leg (total minus the interface fee) does
 * not exceed `maxSwapIn`. Used to tell the trader how much they can pay in.
 */
export function maxTotalForSwapIn(maxSwapIn: bigint, feeBps: number) {
  if (maxSwapIn <= ZERO) return ZERO;
  const fee = bps(feeBps, "Interface fee");
  let total = (maxSwapIn * BPS) / (BPS - fee);
  while (total > ZERO && total - interfaceFeeFor(total, feeBps) > maxSwapIn) total -= ONE;
  return total;
}

/**
 * The smallest total input whose swap leg (total minus the rounded-down
 * interface fee) is exactly `swapIn`. Used for exact-out swaps, so the
 * interface fee is the same one an exact-in swap of that total would pay:
 * `total - interfaceFeeFor(total, feeBps) === swapIn`. That total always
 * exists, because the swap leg grows by 0 or 1 per unit of total.
 */
export function totalForSwapIn(swapIn: string | bigint, feeBps: number) {
  const target = int(swapIn, "Swap amount");
  const fee = bps(feeBps, "Interface fee");
  if (target === ZERO) return ZERO;
  if (fee === BPS) throw new Error("Interface fee must be below 10000 bps");
  const leg = (total: bigint) => total - interfaceFeeFor(total, feeBps);
  let total = ceilDiv(target * BPS, BPS - fee);
  while (leg(total) < target) total += ONE;
  while (total > ONE && leg(total - ONE) >= target) total -= ONE;
  return total;
}

/** Initial LP shares for a new pool: floor(sqrt(a * b)), as in qorechain-core `x/amm/types/pool_test.go`. */
export function initialLpShares(amountA: string | bigint, amountB: string | bigint) {
  return isqrt(int(amountA, "Amount A") * int(amountB, "Amount B")).toString();
}

/**
 * A ratio `numerator / denominator` of two base-unit amounts as a decimal
 * string in display units, with integer math only. Used for prices such as
 * "1 QOR = 2.5 TEST". Rounded down to `fractionDigits`.
 */
export function formatRatio(numerator: string | bigint, numeratorDecimals: number, denominator: string | bigint, denominatorDecimals: number, fractionDigits = 6) {
  const top = int(numerator, "Numerator");
  const bottom = int(denominator, "Denominator");
  if (bottom === ZERO) return null;
  // (top / 10^nd) / (bottom / 10^dd) = top * 10^dd / (bottom * 10^nd)
  const scale = BigInt(10) ** BigInt(fractionDigits);
  const scaled = (top * (BigInt(10) ** BigInt(denominatorDecimals)) * scale) / (bottom * (BigInt(10) ** BigInt(numeratorDecimals)));
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(fractionDigits, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
