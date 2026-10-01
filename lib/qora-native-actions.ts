import { amm, type EncodeObject } from "@qorechain/sdk";

import type { ServerQoraFeeConfig } from "@/lib/qora-fee-config";
import { buildLiquidityRoute } from "@/lib/qora-liquidity-route";
import { buildCreatePoolPlan } from "@/lib/qora-pool-route";
import { buildQoraSwapRoute } from "@/lib/qora-swap-route";

export type NativeAction =
  | { kind: "swap"; poolId: string; denomIn: string; amountIn: string; denomOut: string; minOut: string }
  | { kind: "create_pool"; poolType: "constant_product" | "stable_swap"; denomA: string; amountA: string; denomB: string; amountB: string; amplificationCoefficient?: number }
  | { kind: "add_liquidity"; poolId: string; denomA: string; amountA: string; denomB: string; amountB: string; minLpOut: string }
  | { kind: "remove_liquidity"; poolId: string; lpAmount: string; minAmountA: string; minAmountB: string };

export const NATIVE_ACTION_KINDS = ["swap", "create_pool", "add_liquidity", "remove_liquidity"] as const;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Narrows untrusted JSON into a typed action. Field checks happen in the builders. */
export function parseNativeAction(value: unknown): NativeAction {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  switch (input.kind) {
    case "swap":
      return { kind: "swap", poolId: text(input.poolId), denomIn: text(input.denomIn), amountIn: text(input.amountIn), denomOut: text(input.denomOut), minOut: text(input.minOut) };
    case "create_pool":
      return {
        kind: "create_pool",
        poolType: input.poolType === "stable_swap" ? "stable_swap" : "constant_product",
        denomA: text(input.denomA),
        amountA: text(input.amountA),
        denomB: text(input.denomB),
        amountB: text(input.amountB),
        amplificationCoefficient: typeof input.amplificationCoefficient === "number" ? input.amplificationCoefficient : undefined,
      };
    case "add_liquidity":
      return { kind: "add_liquidity", poolId: text(input.poolId), denomA: text(input.denomA), amountA: text(input.amountA), denomB: text(input.denomB), amountB: text(input.amountB), minLpOut: text(input.minLpOut) };
    case "remove_liquidity":
      return { kind: "remove_liquidity", poolId: text(input.poolId), lpAmount: text(input.lpAmount), minAmountA: text(input.minAmountA), minAmountB: text(input.minAmountB) };
    default:
      throw new Error("Choose a supported action");
  }
}

/**
 * Turns an action into native messages for the sender to sign. A swap carries
 * Qora's disclosed interface fee as a separate transfer only when a treasury is
 * configured; the quote route splits the input the same way.
 */
export function messagesForAction(sender: string, action: NativeAction, fee: ServerQoraFeeConfig): EncodeObject[] {
  switch (action.kind) {
    case "swap":
      if (fee.enabled) {
        return buildQoraSwapRoute({ sender, ...action, fee: { recipient: fee.recipient, feeBps: fee.feeBps } }).messages;
      }
      if (!/^\d+$/.test(action.minOut)) throw new Error("Minimum output must be an integer");
      if (!/^\d+$/.test(action.amountIn) || BigInt(action.amountIn) <= BigInt(0)) throw new Error("Swap amount must be a positive integer");
      if (!/^\d+$/.test(action.poolId) || BigInt(action.poolId) <= BigInt(0)) throw new Error("A valid pool ID is required");
      if (!action.denomIn || !action.denomOut || action.denomIn === action.denomOut) throw new Error("Use two different native token denoms");
      return [amm.swapExactIn({ sender, poolId: action.poolId, tokenIn: { denom: action.denomIn, amount: action.amountIn }, denomOut: action.denomOut, minOut: action.minOut })];
    case "create_pool":
      return [buildCreatePoolPlan({ creator: sender, ...action }).message];
    case "add_liquidity":
      return [buildLiquidityRoute({ action: "add", sender, ...action }).message];
    case "remove_liquidity":
      return [buildLiquidityRoute({ action: "remove", sender, ...action }).message];
  }
}
