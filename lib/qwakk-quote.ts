import type { AmmParams, AmmPool, ChainQuote, QuoteFailure } from "@/lib/qwakk-amm-chain";
import { constantProductOut, curveImpactBps, maxSwapInForImpact, maxTotalForSwapIn, priceImpactBps } from "@/lib/qwakk-amm-math";
import type { ServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";

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

  if (swapAmount <= BigInt(0)) throw new Error("Swap amount is too small after the interface fee");

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

export type SwapQuote = {
  poolId: string;
  poolType: string;
  denomIn: string;
  denomOut: string;
  totalAmountIn: string;
  swapAmountIn: string;
  amountOut: string;
  /** "0" when the quote is blocked. A blocked quote can never be signed. */
  minOut: string;
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
  blocked: QuoteBlock | null;
  /** "chain" is QoreChain's QuoteExactIn. "estimate" is local x*y=k math, used only if the quote service is down. */
  source: "chain" | "estimate";
  reserveIn: string;
  reserveOut: string;
};

export class QuoteError extends Error {
  constructor(readonly failure: QuoteFailure | "pair") {
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
    poolId: request.poolId,
    poolType: pool.poolType,
    denomIn: request.denomIn,
    denomOut,
    totalAmountIn: request.totalAmountIn,
    swapAmountIn: request.swapAmountIn,
    amountOut,
    minOut: blocked ? "0" : minOut,
    nativeAmmFee: fee,
    slippageBps: request.slippageBps,
    interfaceFee: { enabled: request.interfaceFeeEnabled, amount: request.interfaceFee, denom: request.denomIn, feeBps: request.interfaceFeeBps },
    priceImpactBps: priceImpact,
    curveImpactBps: curveImpact,
    maxImpactBps: params.maxSwapImpactBps,
    maxAmountIn,
    blocked,
    source,
    reserveIn,
    reserveOut,
  };
}

/** Identifies the inputs a quote was made for, so a quote is never signed against other inputs. */
export function quoteKey(input: { poolId: string; denomIn: string; amountIn: string; slippageBps: number }) {
  return `${input.poolId}|${input.denomIn}|${input.amountIn}|${input.slippageBps}`;
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
