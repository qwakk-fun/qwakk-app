import type { AmmParams, AmmPool, ChainExactOutQuote, ChainQuote, QuoteFailure } from "@/lib/qwakk-amm-chain";
import { constantProductIn, constantProductOut, curveImpactBps, maxSwapInForImpact, maxTotalForSwapIn, priceImpactBps, totalForSwapIn } from "@/lib/qwakk-amm-math";
import type { ServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { BRAND } from "@/lib/brand";

/** 0.50%: the default price protection for a swap. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** 0.01%: anything tighter fails on ordinary block-to-block movement. */
export const MIN_SLIPPAGE_BPS = 1;
/** 5.00%: above this the protection stops protecting. */
export const MAX_SLIPPAGE_BPS = 500;
/** Above 1.00% the trader is warned that the setting is loose. */
export const SLIPPAGE_WARN_BPS = 100;
/** Price impact (`curveImpactBps`) from 1.00% upward is called out before signing. */
export const IMPACT_WARN_BPS = 100;
/** Choices offered next to a custom value. */
export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;

export type ExactInQuoteInput = {
  poolId: string;
  denomIn: string;
  amountIn: string;
  slippageBps?: number;
  fee: ServerQwakkFeeConfig;
};

export type ExactInQuoteRequest = {
  poolId: string;
  denomIn: string;
  totalAmountIn: string;
  swapAmountIn: string;
  interfaceFee: string;
  interfaceFeeBps: number;
  interfaceFeeEnabled: boolean;
  slippageBps: number;
};

function isPositiveInteger(value: string) {
  return /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

function isValidDenom(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(value);
}

export function isValidSlippageBps(value: number) {
  return Number.isInteger(value) && value >= MIN_SLIPPAGE_BPS && value <= MAX_SLIPPAGE_BPS;
}

const SLIPPAGE_RANGE_ERROR = `Slippage must be between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS} bps`;

/**
 * Splits the user's total input before requesting a native AMM quote. The AMM
 * must quote only the amount that will actually reach MsgSwapExactIn. The
 * interface fee is rounded down, in the trader's favour.
 */
export function buildExactInQuoteRequest(input: ExactInQuoteInput): ExactInQuoteRequest {
  if (!isPositiveInteger(input.poolId)) throw new Error("A valid pool ID is required");
  if (!isValidDenom(input.denomIn)) throw new Error("A valid input denom is required");
  if (!isPositiveInteger(input.amountIn)) throw new Error("Swap amount must be a positive integer");

  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!isValidSlippageBps(slippageBps)) throw new Error(SLIPPAGE_RANGE_ERROR);

  const totalAmount = BigInt(input.amountIn);
  const interfaceFee = input.fee.enabled
    ? (totalAmount * BigInt(input.fee.feeBps)) / BigInt(10_000)
    : BigInt(0);
  const swapAmount = totalAmount - interfaceFee;

  if (swapAmount <= BigInt(0)) throw new Error(`Swap amount is too small after the ${BRAND.name} fee`);

  return {
    poolId: input.poolId,
    denomIn: input.denomIn,
    totalAmountIn: totalAmount.toString(),
    swapAmountIn: swapAmount.toString(),
    interfaceFee: interfaceFee.toString(),
    interfaceFeeBps: input.fee.feeBps,
    interfaceFeeEnabled: input.fee.enabled,
    slippageBps,
  };
}

/** The integer minimum output, rounded down so it never exceeds what the slippage setting allows. */
export function calculateMinimumOut(amountOut: string, slippageBps: number) {
  if (!isPositiveInteger(amountOut)) throw new Error("Quoted output must be a positive integer");
  if (!isValidSlippageBps(slippageBps)) throw new Error(SLIPPAGE_RANGE_ERROR);

  return ((BigInt(amountOut) * BigInt(10_000 - slippageBps)) / BigInt(10_000)).toString();
}

/**
 * Parses a price protection value typed as a percent ("0.5", "0.5%", "1").
 * Returns bps, or null when the text is not a number in the allowed range.
 * At most two decimals, so the value maps exactly to whole bps.
 */
export function parseSlippagePercent(text: string): number | null {
  const value = text.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(?:\.\d{0,2})?$/.test(value) && !/^\.\d{1,2}$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const bps = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  return isValidSlippageBps(bps) ? bps : null;
}

export type QuoteBlock = "impact" | "paused" | "disabled" | "too_small";

/** Which side the trader typed: "exact_in" fixes what they pay, "exact_out" fixes what they receive. */
export type SwapMode = "exact_in" | "exact_out";

export type SwapQuote = {
  mode: SwapMode;
  poolId: string;
  poolType: string;
  denomIn: string;
  denomOut: string;
  /** Quoted total input, interface fee included. Exact out: what the trader pays at the quoted price. */
  totalAmountIn: string;
  /** The part of the total that reaches the AMM. */
  swapAmountIn: string;
  /** Exact out: the amount the trader typed, received exactly. */
  amountOut: string;
  /** "0" when the quote is blocked. A blocked quote can never be signed. Exact out: the typed output. */
  minOut: string;
  /**
   * Price protection on the AMM leg: exact in, the swap leg itself; exact out,
   * MsgSwapExactOut's `maxIn` (the quoted swap leg plus the slippage setting,
   * rounded up). "0" when blocked.
   */
  maxIn: string;
  /** The most the trader can pay: interface fee plus `maxIn`. "0" when blocked. */
  maxTotalIn: string;
  nativeAmmFee: string;
  slippageBps: number;
  interfaceFee: { enabled: boolean; amount: string; denom: string; feeBps: number };
  /** Fee-inclusive impact against the pre-swap mid price. Null for stable pools, where the chain's own cap check is the guard. */
  priceImpactBps: number | null;
  /**
   * The price impact shown to the trader: how far the swap moves the price,
   * without the swap fee or the rounding of a tiny output. Null for stable pools.
   */
  curveImpactBps: number | null;
  maxImpactBps: number;
  /** Largest total input that stays within the impact cap, in base units of denomIn. Null when unknown or uncapped. */
  maxAmountIn: string | null;
  /** Exact out: the largest output that stays within the impact cap, in base units of denomOut. Null otherwise. */
  maxAmountOut: string | null;
  blocked: QuoteBlock | null;
  /** "chain" is QoreChain's QuoteExactIn (QuoteExactOut for exact out). "estimate" is local x*y=k math, used only if the quote service is down. */
  source: "chain" | "estimate";
  reserveIn: string;
  reserveOut: string;
};

export class QuoteError extends Error {
  constructor(readonly failure: QuoteFailure | "pair" | "exact_out_unsupported") {
    super(failure);
  }
}

/**
 * Turns the chain's quote, the pool and the AMM params into what the trader
 * signs against. minOut always comes from the chain's QuoteExactIn when the
 * quote service answers. A swap above the chain's `max_swap_impact_bps`, into
 * a paused pool or while the module is switched off is blocked here, before
 * the wallet opens.
 *
 * `allowEstimate: false` (mainnet, see `requiresChainQuote` in
 * lib/qwakk-network.ts) turns off the local x*y=k fallback: without
 * QoreChain's own QuoteExactIn answer there is no quote to sign against.
 */
export function buildSwapQuote(input: { request: ExactInQuoteRequest; pool: AmmPool; params: AmmParams; chain: ChainQuote; allowEstimate?: boolean }): SwapQuote {
  const { request, pool, params, chain } = input;
  const allowEstimate = input.allowEstimate ?? true;
  const forward = request.denomIn === pool.tokenA;
  if (!forward && request.denomIn !== pool.tokenB) throw new QuoteError("pair");
  const denomOut = forward ? pool.tokenB : pool.tokenA;
  const reserveIn = forward ? pool.reserveA : pool.reserveB;
  const reserveOut = forward ? pool.reserveB : pool.reserveA;
  const constantProduct = pool.poolType === "constant_product";

  let amountOut: string;
  let fee: string;
  let source: SwapQuote["source"] = "chain";
  let chainSaysImpact = false;
  if (chain.ok) {
    amountOut = chain.amountOut;
    fee = chain.fee;
  } else if (allowEstimate && constantProduct && (chain.failure === "unavailable" || chain.failure === "impact_too_high")) {
    const estimate = constantProductOut(request.swapAmountIn, reserveIn, reserveOut, params.swapFeeBps);
    amountOut = estimate.amountOut;
    fee = estimate.fee;
    source = "estimate";
    chainSaysImpact = chain.failure === "impact_too_high";
  } else {
    throw new QuoteError(chain.failure);
  }

  const priceImpact = constantProduct ? priceImpactBps(request.swapAmountIn, amountOut, reserveIn, reserveOut) : null;
  const inAfterFee = /^\d+$/.test(fee) && BigInt(request.swapAmountIn) > BigInt(fee) ? BigInt(request.swapAmountIn) - BigInt(fee) : BigInt(0);
  const curveImpact = constantProduct ? curveImpactBps(inAfterFee, reserveIn) : null;
  const maxSwapIn = constantProduct ? maxSwapInForImpact(reserveIn, reserveOut, params.maxSwapImpactBps, params.swapFeeBps) : null;
  const maxAmountIn = maxSwapIn === null ? null : maxTotalForSwapIn(maxSwapIn, request.interfaceFeeEnabled ? request.interfaceFeeBps : 0).toString();
  const overCap = chainSaysImpact || (params.maxSwapImpactBps > 0 && priceImpact !== null && priceImpact > params.maxSwapImpactBps);

  const minOut = /^\d+$/.test(amountOut) && BigInt(amountOut) > BigInt(0) ? calculateMinimumOut(amountOut, request.slippageBps) : "0";
  const blocked: QuoteBlock | null = !params.enabled
    ? "disabled"
    : pool.status !== "active"
      ? "paused"
      : minOut === "0"
        ? "too_small"
        : overCap
          ? "impact"
          : null;

  return {
    mode: "exact_in",
    poolId: request.poolId,
    poolType: pool.poolType,
    denomIn: request.denomIn,
    denomOut,
    totalAmountIn: request.totalAmountIn,
    swapAmountIn: request.swapAmountIn,
    amountOut,
    minOut: blocked ? "0" : minOut,
    maxIn: blocked ? "0" : request.swapAmountIn,
    maxTotalIn: blocked ? "0" : request.totalAmountIn,
    nativeAmmFee: fee,
    slippageBps: request.slippageBps,
    interfaceFee: { enabled: request.interfaceFeeEnabled, amount: request.interfaceFee, denom: request.denomIn, feeBps: request.interfaceFeeBps },
    priceImpactBps: priceImpact,
    curveImpactBps: curveImpact,
    maxImpactBps: params.maxSwapImpactBps,
    maxAmountIn,
    maxAmountOut: null,
    blocked,
    source,
    reserveIn,
    reserveOut,
  };
}

export type ExactOutQuoteInput = {
  poolId: string;
  denomIn: string;
  /** The output the trader typed, in base units of the pool's other token. */
  amountOut: string;
  slippageBps?: number;
  fee: ServerQwakkFeeConfig;
};

export type ExactOutQuoteRequest = {
  poolId: string;
  denomIn: string;
  amountOut: string;
  interfaceFeeBps: number;
  interfaceFeeEnabled: boolean;
  slippageBps: number;
};

/** Validates an exact-out quote request. The interface fee is set once the chain has quoted the swap leg. */
export function buildExactOutQuoteRequest(input: ExactOutQuoteInput): ExactOutQuoteRequest {
  if (!isPositiveInteger(input.poolId)) throw new Error("A valid pool ID is required");
  if (!isValidDenom(input.denomIn)) throw new Error("A valid input denom is required");
  if (!isPositiveInteger(input.amountOut)) throw new Error("Receive amount must be a positive integer");

  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!isValidSlippageBps(slippageBps)) throw new Error(SLIPPAGE_RANGE_ERROR);

  return {
    poolId: input.poolId,
    denomIn: input.denomIn,
    amountOut: BigInt(input.amountOut).toString(),
    interfaceFeeBps: input.fee.feeBps,
    interfaceFeeEnabled: input.fee.enabled,
    slippageBps,
  };
}

/**
 * MsgSwapExactOut's `maxIn`: the quoted swap leg plus the slippage setting,
 * rounded up so the protection is never tighter than the setting.
 */
export function calculateMaximumIn(amountIn: string, slippageBps: number) {
  if (!isPositiveInteger(amountIn)) throw new Error("Quoted input must be a positive integer");
  if (!isValidSlippageBps(slippageBps)) throw new Error(SLIPPAGE_RANGE_ERROR);
  const scaled = BigInt(amountIn) * BigInt(10_000 + slippageBps);
  return ((scaled + BigInt(9_999)) / BigInt(10_000)).toString();
}

/**
 * Exact-out quote. The swap leg comes from QoreChain's own `QuoteExactOut`
 * (`/qorechain/amm/v1/quote/exact_out`). Qwakk's interface fee is then set on
 * the quoted input, exactly as an exact-in swap of the same total would pay:
 * the total is the smallest one whose swap leg after the rounded-down fee is
 * the quoted leg (`totalForSwapIn`). It is never charged on the slippage
 * padding. `maxIn` pads only the AMM leg, so the most the trader can pay is
 * the fee plus `maxIn`.
 *
 * Only constant-product pools quote exact out. QoreChain's stable-swap pools
 * do not, so those refuse here with `exact_out_unsupported`.
 */
export function buildExactOutSwapQuote(input: { request: ExactOutQuoteRequest; pool: AmmPool; params: AmmParams; chain: ChainExactOutQuote; allowEstimate?: boolean }): SwapQuote {
  const { request, pool, params, chain } = input;
  const allowEstimate = input.allowEstimate ?? true;
  const forward = request.denomIn === pool.tokenA;
  if (!forward && request.denomIn !== pool.tokenB) throw new QuoteError("pair");
  if (pool.poolType !== "constant_product") throw new QuoteError("exact_out_unsupported");
  const denomOut = forward ? pool.tokenB : pool.tokenA;
  const reserveIn = forward ? pool.reserveA : pool.reserveB;
  const reserveOut = forward ? pool.reserveB : pool.reserveA;

  let swapAmountIn: string;
  let fee: string;
  let source: SwapQuote["source"] = "chain";
  let chainSaysImpact = false;
  if (chain.ok) {
    swapAmountIn = chain.amountIn;
    fee = chain.fee;
  } else if (allowEstimate && (chain.failure === "unavailable" || chain.failure === "impact_too_high")) {
    const estimate = constantProductIn(request.amountOut, reserveIn, reserveOut, params.swapFeeBps);
    if (!estimate) throw new QuoteError("insufficient_liquidity");
    swapAmountIn = estimate.amountIn;
    fee = estimate.fee;
    source = "estimate";
    chainSaysImpact = chain.failure === "impact_too_high";
  } else {
    throw new QuoteError(chain.failure);
  }
  if (!isPositiveInteger(swapAmountIn)) throw new QuoteError("unavailable");

  const interfaceFeeBps = request.interfaceFeeEnabled ? request.interfaceFeeBps : 0;
  const total = totalForSwapIn(swapAmountIn, interfaceFeeBps);
  const interfaceFee = total - BigInt(swapAmountIn);

  const priceImpact = priceImpactBps(swapAmountIn, request.amountOut, reserveIn, reserveOut);
  const inAfterFee = /^\d+$/.test(fee) && BigInt(swapAmountIn) > BigInt(fee) ? BigInt(swapAmountIn) - BigInt(fee) : BigInt(0);
  const curveImpact = curveImpactBps(inAfterFee, reserveIn);
  const maxSwapIn = maxSwapInForImpact(reserveIn, reserveOut, params.maxSwapImpactBps, params.swapFeeBps);
  const maxAmountIn = maxSwapIn === null ? null : maxTotalForSwapIn(maxSwapIn, interfaceFeeBps).toString();
  const maxAmountOut = maxSwapIn === null ? null : constantProductOut(maxSwapIn, reserveIn, reserveOut, params.swapFeeBps).amountOut;
  const overCap = chainSaysImpact || (params.maxSwapImpactBps > 0 && priceImpact > params.maxSwapImpactBps);

  const blocked: QuoteBlock | null = !params.enabled
    ? "disabled"
    : pool.status !== "active"
      ? "paused"
      : overCap
        ? "impact"
        : null;
  const maxIn = blocked ? "0" : calculateMaximumIn(swapAmountIn, request.slippageBps);

  return {
    mode: "exact_out",
    poolId: request.poolId,
    poolType: pool.poolType,
    denomIn: request.denomIn,
    denomOut,
    totalAmountIn: total.toString(),
    swapAmountIn,
    amountOut: request.amountOut,
    minOut: blocked ? "0" : request.amountOut,
    maxIn,
    maxTotalIn: blocked ? "0" : (interfaceFee + BigInt(maxIn)).toString(),
    nativeAmmFee: fee,
    slippageBps: request.slippageBps,
    interfaceFee: { enabled: request.interfaceFeeEnabled, amount: interfaceFee.toString(), denom: request.denomIn, feeBps: request.interfaceFeeBps },
    priceImpactBps: priceImpact,
    curveImpactBps: curveImpact,
    maxImpactBps: params.maxSwapImpactBps,
    maxAmountIn,
    maxAmountOut: maxAmountOut === "0" ? null : maxAmountOut,
    blocked,
    source,
    reserveIn,
    reserveOut,
  };
}

/**
 * Sign-time check for an exact-out swap: the trader reviewed the most they
 * can pay (`reviewedMaxTotalIn`). A fresh quote may be signed only if it
 * delivers the same output for no more than that; otherwise the new numbers
 * go back to the trader for review.
 */
export function requoteExactOutDecision(reviewed: Pick<SwapQuote, "amountOut" | "maxTotalIn">, fresh: Pick<SwapQuote, "mode" | "amountOut" | "maxTotalIn" | "blocked">): "sign" | "review" {
  if (fresh.blocked || fresh.mode !== "exact_out" || fresh.amountOut !== reviewed.amountOut) return "review";
  if (!isPositiveInteger(fresh.maxTotalIn) || !isPositiveInteger(reviewed.maxTotalIn)) return "review";
  return BigInt(fresh.maxTotalIn) <= BigInt(reviewed.maxTotalIn) ? "sign" : "review";
}

/** Identifies the inputs a quote was made for, so a quote is never signed against other inputs. */
export function quoteKey(input: { poolId: string; denomIn: string; slippageBps: number } & ({ amountIn: string } | { amountOut: string })) {
  return "amountOut" in input
    ? `${input.poolId}|${input.denomIn}|out:${input.amountOut}|${input.slippageBps}`
    : `${input.poolId}|${input.denomIn}|${input.amountIn}|${input.slippageBps}`;
}

/**
 * Sign-time check: the trader reviewed `reviewedMinOut`. A fresh quote may be
 * signed only if it still guarantees at least that much; otherwise the new
 * numbers go back to the trader for review.
 */
export function requoteDecision(reviewedMinOut: string, fresh: Pick<SwapQuote, "minOut" | "blocked">): "sign" | "review" {
  if (fresh.blocked || !/^\d+$/.test(fresh.minOut) || !/^\d+$/.test(reviewedMinOut)) return "review";
  if (BigInt(fresh.minOut) <= BigInt(0)) return "review";
  return BigInt(fresh.minOut) >= BigInt(reviewedMinOut) ? "sign" : "review";
}

/**
 * QOR kept aside for the network fee when checking a balance in the browser
 * (0.1 QOR). A swap or deposit simulates at roughly 150k to 300k gas, which
 * QoreX prices at 0.15 uqor per gas, so about 0.02 to 0.05 QOR. The prepare
 * route then checks the exact simulated fee before the wallet opens.
 */
export const NETWORK_FEE_RESERVE_UQOR = BigInt(100_000);

/**
 * Whether a balance covers `amount` of `denom`, plus `extraUqor` (such as a
 * pool creation fee) and the network fee reserve when the denom is uqor.
 * QOR for the fee is required even when the trade spends another token.
 */
export function coversSpend(input: { balances: ReadonlyMap<string, bigint>; spend: ReadonlyArray<{ denom: string; amount: string }>; extraUqor?: bigint }) {
  const need = new Map<string, bigint>();
  for (const coin of input.spend) {
    if (!/^\d+$/.test(coin.amount)) return false;
    need.set(coin.denom, (need.get(coin.denom) ?? BigInt(0)) + BigInt(coin.amount));
  }
  need.set("uqor", (need.get("uqor") ?? BigInt(0)) + (input.extraUqor ?? BigInt(0)) + NETWORK_FEE_RESERVE_UQOR);
  for (const [denom, amount] of need) {
    if ((input.balances.get(denom) ?? BigInt(0)) < amount) return false;
  }
  return true;
}
