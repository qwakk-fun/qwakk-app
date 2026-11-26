import { amm, type EncodeObject } from "@qorechain/sdk";

import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

import type { ServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { buildLiquidityRoute } from "@/lib/qwakk-liquidity-route";
import { REWARDS_CLAIM_KIND, buildRewardsClaimMessage, parseRewardsClaimAction, type RewardsClaimAction } from "@/lib/qwakk-native-rewards";
import { SEND_KIND, buildSendMessage, isAllowedSend, parseSendAction, type SendAction } from "@/lib/qwakk-native-send";
import { encodeAsAny, isAllowedMessageSet } from "@/lib/qwakk-native-tx";
import { buildCreatePoolPlan } from "@/lib/qwakk-pool-route";
import { buildQwakkExactOutSwapRoute, buildQwakkSwapRoute } from "@/lib/qwakk-swap-route";

/** Exact in: the trader fixes what they pay (`amountIn`, interface fee included) and is protected by `minOut`. */
export type ExactInSwapAction = { kind: "swap"; mode?: "exact_in"; poolId: string; denomIn: string; amountIn: string; denomOut: string; minOut: string };
/**
 * Exact out: the trader fixes what they receive (`amountOut`). `amountIn` is
 * the quoted total, interface fee included, and `maxIn` the most the AMM leg
 * may take (MsgSwapExactOut `max_in`).
 */
export type ExactOutSwapAction = { kind: "swap"; mode: "exact_out"; poolId: string; denomIn: string; amountIn: string; denomOut: string; amountOut: string; maxIn: string };
export type SwapAction = ExactInSwapAction | ExactOutSwapAction;

export function isExactOutSwap(action: NativeAction): action is ExactOutSwapAction {
  return action.kind === "swap" && action.mode === "exact_out";
}

export type NativeAction =
  | SwapAction
  | { kind: "create_pool"; poolType: "constant_product" | "stable_swap"; denomA: string; amountA: string; denomB: string; amountB: string; amplificationCoefficient?: number }
  | { kind: "add_liquidity"; poolId: string; denomA: string; amountA: string; denomB: string; amountB: string; minLpOut: string }
  | { kind: "remove_liquidity"; poolId: string; lpAmount: string; minAmountA: string; minAmountB: string }
  | RewardsClaimAction
  | SendAction;

// Browser code imports these from lib/qwakk-send-action.ts, which has no SDK imports.
export { SEND_KIND, sendAction, type SendAction } from "@/lib/qwakk-send-action";

export const NATIVE_ACTION_KINDS = ["swap", "create_pool", "add_liquidity", "remove_liquidity", REWARDS_CLAIM_KIND, SEND_KIND] as const;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Narrows untrusted JSON into a typed action. Field checks happen in the builders. */
export function parseNativeAction(value: unknown): NativeAction {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  switch (input.kind) {
    case "swap":
      if (input.mode === "exact_out") {
        return { kind: "swap", mode: "exact_out", poolId: text(input.poolId), denomIn: text(input.denomIn), amountIn: text(input.amountIn), denomOut: text(input.denomOut), amountOut: text(input.amountOut), maxIn: text(input.maxIn) };
      }
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
    case REWARDS_CLAIM_KIND:
    case "rewards-claim":
      return parseRewardsClaimAction(input);
    case SEND_KIND:
      return parseSendAction(input);
    default:
      throw new Error("Choose a supported action");
  }
}

/**
 * Server-side check of an exact-out swap against QoreChain's own
 * QuoteExactOut `amount_in` for the same output, run by the prepare route
 * before anything is built. The interface fee is taken from the client's
 * quoted total, so the swap leg that total implies (total minus the fee the
 * server recomputes) must cover the chain's input. Otherwise a client could
 * send a smaller total with a padded `maxIn` and let the AMM take the rest,
 * paying a smaller fee than an exact-in swap of the same size.
 *
 * No tolerance: an honest client re-quotes right before it asks to prepare.
 * If the price moved against it in between, the trader is asked to review
 * the new quote ("price_moved"), which is also what the chain itself does
 * once the input passes `maxIn`.
 *
 * "ok" also covers input the builder will reject with its own message.
 */
export function exactOutQuoteCheck(action: ExactOutSwapAction, fee: ServerQwakkFeeConfig, chainAmountIn: string): "ok" | "price_moved" {
  if (!/^\d+$/.test(action.amountIn) || !/^\d+$/.test(chainAmountIn)) return "ok";
  const feeBps = fee.enabled ? fee.feeBps : 0;
  const total = BigInt(action.amountIn);
  const swapLeg = total - (total * BigInt(feeBps)) / BigInt(10_000);
  return swapLeg >= BigInt(chainAmountIn) ? "ok" : "price_moved";
}

/**
 * Turns an action into native messages for the sender to sign. A swap carries
 * Qwakk's disclosed interface fee as a separate transfer only when a treasury is
 * configured; the quote route splits the input the same way.
 */
export function messagesForAction(sender: string, action: NativeAction, fee: ServerQwakkFeeConfig): EncodeObject[] {
  switch (action.kind) {
    case "swap":
      if (action.mode === "exact_out") {
        return buildQwakkExactOutSwapRoute({
          sender,
          poolId: action.poolId,
          denomIn: action.denomIn,
          amountIn: action.amountIn,
          denomOut: action.denomOut,
          amountOut: action.amountOut,
          maxIn: action.maxIn,
          fee: fee.enabled ? { recipient: fee.recipient, feeBps: fee.feeBps } : null,
        }).messages;
      }
      if (fee.enabled) {
        return buildQwakkSwapRoute({ sender, ...action, fee: { recipient: fee.recipient, feeBps: fee.feeBps } }).messages;
      }
      if (!/^\d+$/.test(action.minOut) || BigInt(action.minOut) <= BigInt(0)) throw new Error("A minimum output is required");
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
    case REWARDS_CLAIM_KIND:
      // A contract message is not in the SDK registry; encodedMessagesForAction builds it.
      throw new Error("Rewards claims are built by encodedMessagesForAction");
    case SEND_KIND:
      // Not an AMM message: encodedMessagesForAction builds and checks it on its own path.
      throw new Error("Sends are built by encodedMessagesForAction");
  }
}

/**
 * Builds, encodes and checks the messages QoreX will be asked to sign. The
 * sender is always the connected address, and only native AMM messages plus the
 * disclosed treasury fee transfer can leave the server, or a single rewards
 * claim to the configured rewards contract (`rewardsContract`; null keeps
 * claims off), or a single token send from the sender (no interface fee).
 */
export function encodedMessagesForAction(sender: string, action: NativeAction, fee: ServerQwakkFeeConfig, rewardsContract: string | null = null): Any[] {
  if (action.kind === REWARDS_CLAIM_KIND) {
    if (!rewardsContract) throw new Error("Rewards claims are not available right now");
    const encoded = [buildRewardsClaimMessage({ sender, contract: rewardsContract, stageId: action.stageId, amount: action.amount, proof: action.proof })];
    if (!isAllowedMessageSet(encoded, sender, undefined, rewardsContract)) throw new Error("Only native AMM transactions can be prepared here");
    return encoded;
  }
  if (action.kind === SEND_KIND) {
    const encoded = encodeAsAny([buildSendMessage(sender, action)]);
    if (!isAllowedSend(encoded, sender, action)) throw new Error("Only native AMM transactions can be prepared here");
    return encoded;
  }
  const encoded = encodeAsAny(messagesForAction(sender, action, fee));
  if (!isAllowedMessageSet(encoded, sender, fee.enabled ? fee.recipient : undefined)) {
    throw new Error("Only native AMM transactions can be prepared here");
  }
  return encoded;
}

const SWAP_MESSAGE_TYPES = new Set(["/qorechain.amm.v1.MsgSwapExactIn", "/qorechain.amm.v1.MsgSwapExactOut"]);

/**
 * The interface fee carried by an allowed message set, read back from the
 * encoded transfer itself so the disclosed amount is exactly what QoreX signs.
 * Only a swap carries one, so a set without a swap message (a token send is a
 * lone MsgSend) reports null. Null when the set carries no fee transfer.
 */
export function interfaceFeeInMessages(encoded: readonly Any[]): { denom: string; amount: string } | null {
  if (!encoded.some((message) => SWAP_MESSAGE_TYPES.has(message.typeUrl))) return null;
  const transfer = encoded.find((message) => message.typeUrl === "/cosmos.bank.v1beta1.MsgSend");
  if (!transfer) return null;
  const [coin] = MsgSend.decode(transfer.value).amount;
  return coin ? { denom: coin.denom, amount: coin.amount } : null;
}
