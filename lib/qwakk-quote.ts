import type { ServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;

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

/**
 * Splits the user's total input before requesting a native AMM quote. The AMM
 * must quote only the amount that will actually reach MsgSwapExactIn.
 */
export function buildExactInQuoteRequest(input: ExactInQuoteInput): ExactInQuoteRequest {
  if (!isPositiveInteger(input.poolId)) throw new Error("A valid pool ID is required");
  if (!isValidDenom(input.denomIn)) throw new Error("A valid input denom is required");
  if (!isPositiveInteger(input.amountIn)) throw new Error("Swap amount must be a positive integer");

  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`Slippage must be between 1 and ${MAX_SLIPPAGE_BPS} bps`);
  }

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

/** Calculates the integer minimum output without floating-point rounding. */
export function calculateMinimumOut(amountOut: string, slippageBps: number) {
  if (!isPositiveInteger(amountOut)) throw new Error("Quoted output must be a positive integer");
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`Slippage must be between 1 and ${MAX_SLIPPAGE_BPS} bps`);
  }

  return ((BigInt(amountOut) * BigInt(10_000 - slippageBps)) / BigInt(10_000)).toString();
}
