/**
 * Integer planner for moving a constant-product pool's price to a target with
 * a series of exact-in swaps that each stay under the chain's impact cap.
 * Operator tooling (scripts/qwakk-reprice-pool.ts); pure, no network.
 *
 * Chain rules it models, each checked against QoreChain Diana on 2026-10-31:
 * - Output: `out = floor(rOut * a / (rIn + a))`, with `a` the input after the
 *   `swap_fee_bps` fee. A 46000-unit fETH input on pool 1 quoted fee 138 and
 *   out 45608, and the simulated `amm_swap` event matched.
 * - Impact: the quote's `impact_bps` leaves the fee out. For that input it was
 *   448, which is `1 - out / (a * rOut / rIn)` rounded up. The cap
 *   (`max_swap_impact_bps`, 500) is enforced on every swap
 *   (docs.qorechain.io/architecture/amm#swap-rules).
 * - Reserves: the protocol share of the fee (`protocol_fee_bps`, rounded down:
 *   46 for a 46001 input in the `amm_swap` event) leaves the pool, so the
 *   input reserve grows by `in - protocolFee` (docs: architecture/amm#parameters).
 * - A pool may run on tiny reserves: a keyless simulation swapping 4 units
 *   against a pool emptied to about 0.01% was accepted. `min_liquidity` only
 *   applies to a new pool's initial deposits (docs: architecture/amm#parameters).
 *
 * The swap fee is rounded up here. If the chain rounds it down it pays the
 * same or one unit more, so a plan never promises more than the chain gives.
 * The script re-reads the pool and the chain's own quote before every step.
 */

const BPS = BigInt(10_000);
const ZERO = BigInt(0);
const ONE = BigInt(1);

export type RepriceParams = { swapFeeBps: number; protocolFeeBps: number; maxSwapImpactBps: number };

/** A raw price: `num / den` quote base units per base base unit. */
export type Ratio = { num: bigint; den: bigint };

function ceilDiv(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - ONE) / denominator;
}

/**
 * Parses a display price ("3000", "2999.5") of quote per base into a raw
 * ratio of base units, with integer math only.
 */
export function parseTargetRatio(price: string, baseDecimals: number, quoteDecimals: number): Ratio {
  const text = price.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("The target price must be a positive decimal number");
  for (const decimals of [baseDecimals, quoteDecimals]) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token decimals must be whole numbers from 0 to 36");
  }
  const [whole, fraction = ""] = text.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  if (digits === ZERO) throw new Error("The target price must be above zero");
  // price = digits / 10^f quote per base; raw = price * 10^qd / 10^bd.
  return { num: digits * BigInt(10) ** BigInt(quoteDecimals), den: BigInt(10) ** BigInt(fraction.length + baseDecimals) };
}

/**
 * How far the pool's raw price `reserveQuote / reserveBase` is from the
 * target, in bps of the target, signed: positive when the pool is above it.
 * Rounded toward zero.
 */
export function deviationBps(reserveBase: bigint, reserveQuote: bigint, target: Ratio) {
  // (rq/rb) / (num/den) - 1 = (rq*den - rb*num) / (rb*num)
  const top = reserveQuote * target.den - reserveBase * target.num;
  return Number((top * BPS) / (reserveBase * target.num));
}

export type SwapOutcome = {
  amountIn: bigint;
  fee: bigint;
  inAfterFee: bigint;
  amountOut: bigint;
  protocolFee: bigint;
  impactBps: number;
  reserveInAfter: bigint;
  reserveOutAfter: bigint;
};

/** The chain's fee-free impact measure, rounded up. */
export function chainImpactBps(inAfterFee: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint) {
  if (inAfterFee <= ZERO || reserveIn <= ZERO || reserveOut <= ZERO) return 10_000;
  const ideal = inAfterFee * reserveOut;
  const actual = amountOut * reserveIn;
  if (actual >= ideal) return 0;
  const impact = ceilDiv((ideal - actual) * BPS, ideal);
  return Number(impact > BPS ? BPS : impact);
}

export function swapOutcome(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, params: RepriceParams): SwapOutcome {
  const fee = ceilDiv(amountIn * BigInt(params.swapFeeBps), BPS);
  const inAfterFee = amountIn - fee;
  const amountOut = inAfterFee > ZERO ? (reserveOut * inAfterFee) / (reserveIn + inAfterFee) : ZERO;
  const protocolFee = (amountIn * BigInt(params.protocolFeeBps)) / BPS;
  return {
    amountIn,
    fee,
    inAfterFee,
    amountOut,
    protocolFee,
    impactBps: chainImpactBps(inAfterFee, amountOut, reserveIn, reserveOut),
    reserveInAfter: reserveIn + amountIn - protocolFee,
    reserveOutAfter: reserveOut - amountOut,
  };
}

/**
 * The smallest input that returns at least `k` out. Paying more for the same
 * floored output would only add impact, so every step uses this input.
 */
export function minInputForOutput(k: bigint, reserveIn: bigint, reserveOut: bigint, swapFeeBps: number): bigint | null {
  if (k <= ZERO || k >= reserveOut || reserveIn <= ZERO) return null;
  const afterFee = ceilDiv(k * reserveIn, reserveOut - k);
  const feeBps = BigInt(swapFeeBps);
  const keep = (gross: bigint) => gross - ceilDiv(gross * feeBps, BPS);
  let gross = ceilDiv(afterFee * BPS, BPS - feeBps);
  while (keep(gross) < afterFee) gross += ONE;
  while (gross > ONE && keep(gross - ONE) >= afterFee) gross -= ONE;
  return gross;
}

export type RepriceDirection = "sell_base" | "sell_quote";

export type RepriceStep = {
  index: number;
  /** Which side goes into the pool. */
  direction: RepriceDirection;
  amountIn: bigint;
  amountOut: bigint;
  /** The exact modelled output: the swap is refused if the chain would give less. */
  minOut: bigint;
  impactBps: number;
  reserveBaseAfter: bigint;
  reserveQuoteAfter: bigint;
  deviationBpsAfter: number;
};

export type RepriceStop =
  | "target"
  /** One more unit of output would move the price past the target: this is as close as swaps get. */
  | "granularity"
  /** Even a one-unit output breaks the step impact limit: the output reserve is too small. */
  | "impact_floor"
  | "max_steps";

export type RepricePlan = {
  direction: RepriceDirection | null;
  steps: RepriceStep[];
  stop: RepriceStop;
  reserveBase: bigint;
  reserveQuote: bigint;
  deviationBps: number;
  totalBaseIn: bigint;
  totalBaseOut: bigint;
  totalQuoteIn: bigint;
  totalQuoteOut: bigint;
  /** The smallest reserve each side reaches along the plan. */
  minReserveBase: bigint;
  minReserveQuote: bigint;
};

export type RepriceInput = {
  reserveBase: bigint;
  reserveQuote: bigint;
  target: Ratio;
  params: RepriceParams;
  /** Planned impact per step, below the chain cap to leave room for rounding. */
  stepImpactBps: number;
  /** Close enough to the target, in bps either way. */
  toleranceBps: number;
  maxSteps: number;
};

function pastTarget(direction: RepriceDirection, reserveBase: bigint, reserveQuote: bigint, target: Ratio) {
  const cross = reserveQuote * target.den - reserveBase * target.num;
  // Selling base lowers the price: past the target once it is below it.
  return direction === "sell_base" ? cross < ZERO : cross > ZERO;
}

/**
 * The next swap toward the target from these reserves, or why there is none.
 * Picks the largest output `k` whose minimal input keeps the chain's impact
 * within `stepImpactBps` and does not carry the price past the target.
 */
export function nextRepriceStep(reserveBase: bigint, reserveQuote: bigint, target: Ratio, params: RepriceParams, stepImpactBps: number, toleranceBps: number):
  { step: Omit<RepriceStep, "index"> } | { stop: Exclude<RepriceStop, "max_steps"> } {
  if (!Number.isInteger(stepImpactBps) || stepImpactBps <= 0 || stepImpactBps > params.maxSwapImpactBps) {
    throw new Error(`The step impact must be between 1 and the chain's ${params.maxSwapImpactBps} bps`);
  }
  const deviation = deviationBps(reserveBase, reserveQuote, target);
  if (Math.abs(deviation) <= toleranceBps) return { stop: "target" };
  const direction: RepriceDirection = deviation > 0 ? "sell_base" : "sell_quote";
  const reserveIn = direction === "sell_base" ? reserveBase : reserveQuote;
  const reserveOut = direction === "sell_base" ? reserveQuote : reserveBase;

  const at = (k: bigint) => {
    const amountIn = minInputForOutput(k, reserveIn, reserveOut, params.swapFeeBps);
    if (amountIn === null) return null;
    const outcome = swapOutcome(amountIn, reserveIn, reserveOut, params);
    const base = direction === "sell_base" ? outcome.reserveInAfter : outcome.reserveOutAfter;
    const quote = direction === "sell_base" ? outcome.reserveOutAfter : outcome.reserveInAfter;
    return { outcome, base, quote, overshoots: pastTarget(direction, base, quote, target) };
  };

  // Impact is about k / reserveOut: start there and step down past rounding.
  let k = (reserveOut * BigInt(stepImpactBps)) / BPS;
  if (k < ONE) k = ONE;
  let best = at(k);
  while (k > ONE && (best === null || best.outcome.impactBps > stepImpactBps)) {
    k -= k / BigInt(1_000) + ONE;
    if (k < ONE) k = ONE;
    best = at(k);
  }
  if (best === null || best.outcome.impactBps > stepImpactBps) return { stop: "impact_floor" };

  if (best.overshoots) {
    // The price after a step moves monotonically with k: binary search the
    // largest k that stays on this side of the target.
    let low = ZERO;
    let high = k;
    while (high - low > ONE) {
      const mid = (low + high) / BigInt(2);
      const candidate = at(mid);
      if (candidate && !candidate.overshoots) low = mid;
      else high = mid;
    }
    if (low === ZERO) return { stop: "granularity" };
    best = at(low);
    if (best === null || best.outcome.impactBps > stepImpactBps) return { stop: "granularity" };
  }

  const { outcome, base, quote } = best;
  return {
    step: {
      direction,
      amountIn: outcome.amountIn,
      amountOut: outcome.amountOut,
      minOut: outcome.amountOut,
      impactBps: outcome.impactBps,
      reserveBaseAfter: base,
      reserveQuoteAfter: quote,
      deviationBpsAfter: deviationBps(base, quote, target),
    },
  };
}

/** Plans every step from the given reserves, as if no one else trades in between. */
export function planReprice(input: RepriceInput): RepricePlan {
  if (input.reserveBase <= ZERO || input.reserveQuote <= ZERO) throw new Error("The pool has no reserves to reprice");
  const steps: RepriceStep[] = [];
  let reserveBase = input.reserveBase;
  let reserveQuote = input.reserveQuote;
  let minReserveBase = reserveBase;
  let minReserveQuote = reserveQuote;
  let stop: RepriceStop = "max_steps";
  while (steps.length < input.maxSteps) {
    const next = nextRepriceStep(reserveBase, reserveQuote, input.target, input.params, input.stepImpactBps, input.toleranceBps);
    if ("stop" in next) {
      stop = next.stop;
      break;
    }
    steps.push({ index: steps.length + 1, ...next.step });
    reserveBase = next.step.reserveBaseAfter;
    reserveQuote = next.step.reserveQuoteAfter;
    if (reserveBase < minReserveBase) minReserveBase = reserveBase;
    if (reserveQuote < minReserveQuote) minReserveQuote = reserveQuote;
  }
  if (stop === "max_steps" && Math.abs(deviationBps(reserveBase, reserveQuote, input.target)) <= input.toleranceBps) stop = "target";

  const sum = (direction: RepriceDirection, field: "amountIn" | "amountOut") => steps.filter((step) => step.direction === direction).reduce((total, step) => total + step[field], ZERO);
  return {
    direction: steps[0]?.direction ?? null,
    steps,
    stop,
    reserveBase,
    reserveQuote,
    deviationBps: deviationBps(reserveBase, reserveQuote, input.target),
    totalBaseIn: sum("sell_base", "amountIn"),
    totalQuoteOut: sum("sell_base", "amountOut"),
    totalQuoteIn: sum("sell_quote", "amountIn"),
    totalBaseOut: sum("sell_quote", "amountOut"),
    minReserveBase,
    minReserveQuote,
  };
}

export type DepositPlan = { baseAmount: bigint; quoteAmount: bigint; expectedLp: bigint; minLp: bigint };

/**
 * A proportional deposit for a pool that already has liquidity. The keeper
 * takes only the proportional amounts (a keyless simulation offering 3.3e13
 * fETH units with 100000 uqor took 96060 and 100000), so the base side is
 * offered rounded up and the quote side sets the size. LP minted is the
 * smaller proportional share; `minLp` allows `slippageBps` below it.
 */
export function planDeposit(quoteAmount: bigint, reserveBase: bigint, reserveQuote: bigint, lpSupply: bigint, slippageBps = 100): DepositPlan {
  if (quoteAmount <= ZERO || reserveBase <= ZERO || reserveQuote <= ZERO || lpSupply <= ZERO) throw new Error("The deposit needs a positive amount and a pool with liquidity");
  const baseAmount = ceilDiv(quoteAmount * reserveBase, reserveQuote);
  const byQuote = (quoteAmount * lpSupply) / reserveQuote;
  const byBase = (baseAmount * lpSupply) / reserveBase;
  const expectedLp = byQuote < byBase ? byQuote : byBase;
  const minLp = (expectedLp * (BPS - BigInt(slippageBps))) / BPS;
  return { baseAmount, quoteAmount, expectedLp, minLp: minLp > ZERO ? minLp : ONE };
}

/** Floor square root (Newton), for the LP a fresh deposit mints. */
function isqrt(value: bigint) {
  if (value < BigInt(2)) return value;
  let x = value;
  let y = (x + ONE) / BigInt(2);
  while (y < x) {
    x = y;
    y = (x + value / x) / BigInt(2);
  }
  return x;
}

/**
 * The reset route: the only LP holder withdraws everything and deposits again
 * at the target ratio in the same transaction. An emptied pool takes the new
 * ratio like a first deposit (keyless simulation on Diana pool 1: LP minted
 * `floor(sqrt(base * quote))`). The base side is the quote amount at the
 * target ratio, rounded to the nearest unit.
 */
export function planResetDeposit(quoteAmount: bigint, target: Ratio, slippageBps = 100): DepositPlan {
  if (quoteAmount <= ZERO) throw new Error("The deposit needs a positive amount");
  const baseAmount = (quoteAmount * target.den * BigInt(2) + target.num) / (target.num * BigInt(2));
  if (baseAmount <= ZERO) throw new Error("The quote amount is too small for the target price");
  const expectedLp = isqrt(baseAmount * quoteAmount);
  const minLp = (expectedLp * (BPS - BigInt(slippageBps))) / BPS;
  return { baseAmount, quoteAmount, expectedLp, minLp: minLp > ZERO ? minLp : ONE };
}
