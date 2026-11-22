import { amm, bank, type EncodeObject } from "@qorechain/sdk";
import { BRAND } from "./brand";

/**
 * Qwakk's application fee is deliberately separate from the native AMM fee.
 * The caller must disclose it before the user signs the transaction.
 */
export const DEFAULT_QWAKK_INTERFACE_FEE_BPS = 10;

/**
 * Public promise on the fees page: the interface fee never exceeds 0.30%.
 * Every path that sets or applies the fee enforces this cap.
 */
export const MAX_QWAKK_INTERFACE_FEE_BPS = 30;

export type QwakkFeeConfig = {
  /** Qwakk treasury. Leave unset until a production treasury is approved. */
  recipient: string;
  /** 10 bps = 0.10%. Keep this low and visible in the confirmation UI. */
  feeBps?: number;
};

export type SwapRouteInput = {
  sender: string;
  poolId: string;
  denomIn: string;
  /** Total amount the user is willing to spend, in the native integer denom. */
  amountIn: string;
  denomOut: string;
  minOut: string;
  fee: QwakkFeeConfig;
};

export type QwakkSwapRoute = {
  /** Amount used by the AMM after the explicitly disclosed Qwakk fee. */
  swapAmount: string;
  interfaceFee: { denom: string; amount: string };
  /** Fee transfer first, then native AMM swap. Both are signed in one transaction. */
  messages: EncodeObject[];
};

function isPositiveInteger(value: string) {
  return /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

function validateAddress(address: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(address);
}

/**
 * Builds a non-custodial route only. It never signs, broadcasts, or receives
 * user funds. QoreX `signAndBroadcast` asks the user to approve the messages,
 * adds the hybrid PQC layer, signs and broadcasts them in the wallet.
 */
export function buildQwakkSwapRoute(input: SwapRouteInput): QwakkSwapRoute {
  const feeBps = input.fee.feeBps ?? DEFAULT_QWAKK_INTERFACE_FEE_BPS;
  if (!validateAddress(input.sender)) throw new Error("A valid sender address is required");
  if (!validateAddress(input.fee.recipient)) throw new Error("A valid Qwakk treasury address is required");
  if (!/^\d+$/.test(input.poolId) || BigInt(input.poolId) <= BigInt(0)) throw new Error("A valid pool ID is required");
  if (!isPositiveInteger(input.amountIn)) throw new Error("Swap amount must be a positive integer");
  // The chain accepts 0, which would mean no price protection. Qwakk never sends it.
  if (!/^\d+$/.test(input.minOut) || BigInt(input.minOut) <= BigInt(0)) throw new Error("A minimum output is required");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_QWAKK_INTERFACE_FEE_BPS) throw new Error(`Interface fee must be between 0 and ${MAX_QWAKK_INTERFACE_FEE_BPS} bps`);

  const totalAmount = BigInt(input.amountIn);
  const interfaceFee = (totalAmount * BigInt(feeBps)) / BigInt(10_000);
  const swapAmount = totalAmount - interfaceFee;
  if (swapAmount <= BigInt(0)) throw new Error(`Swap amount is too small after the ${BRAND.name} fee`);

  const messages: EncodeObject[] = [];
  if (interfaceFee > BigInt(0)) {
    messages.push(bank.send({
      fromAddress: input.sender,
      toAddress: input.fee.recipient,
      amount: [{ denom: input.denomIn, amount: interfaceFee.toString() }],
    }));
  }
  messages.push(amm.swapExactIn({
    sender: input.sender,
    poolId: input.poolId,
    tokenIn: { denom: input.denomIn, amount: swapAmount.toString() },
    denomOut: input.denomOut,
    minOut: input.minOut,
  }));

  return {
    swapAmount: swapAmount.toString(),
    interfaceFee: { denom: input.denomIn, amount: interfaceFee.toString() },
    messages,
  };
}

/**
 * The most MsgSwapExactOut's `maxIn` may sit above the quoted swap leg. It
 * matches Qwakk's widest price protection (5.00%, `MAX_SLIPPAGE_BPS` in
 * lib/qwakk-quote.ts) and keeps the interface fee tied to what the AMM
 * really takes: a tiny quoted total with a huge `maxIn` is refused here.
 */
export const MAX_EXACT_OUT_PADDING_BPS = 500;

export type ExactOutSwapRouteInput = {
  sender: string;
  poolId: string;
  denomIn: string;
  /** The quoted total input, interface fee included, in the native integer denom. */
  amountIn: string;
  denomOut: string;
  /** The output the trader receives exactly. */
  amountOut: string;
  /** Price protection on the AMM leg: the most MsgSwapExactOut may take. */
  maxIn: string;
  /** Null when no treasury is configured: then no interface fee is charged. */
  fee: QwakkFeeConfig | null;
};

export type QwakkExactOutSwapRoute = {
  /** The quoted AMM leg: the quoted total minus the interface fee. */
  swapAmount: string;
  maxIn: string;
  interfaceFee: { denom: string; amount: string };
  /** Fee transfer first, then MsgSwapExactOut. Both are signed in one transaction. */
  messages: EncodeObject[];
};

/**
 * Exact-out route. The interface fee is the one an exact-in swap of the quoted
 * total pays (rounded down, in the trader's favour), so it is set on the
 * quoted input and never on the slippage padding. MsgSwapExactOut then takes
 * at most `maxIn` for exactly `amountOut`. Like the exact-in route it never
 * signs, broadcasts or receives user funds.
 */
export function buildQwakkExactOutSwapRoute(input: ExactOutSwapRouteInput): QwakkExactOutSwapRoute {
  const feeBps = input.fee ? input.fee.feeBps ?? DEFAULT_QWAKK_INTERFACE_FEE_BPS : 0;
  if (!validateAddress(input.sender)) throw new Error("A valid sender address is required");
  if (input.fee && !validateAddress(input.fee.recipient)) throw new Error("A valid Qwakk treasury address is required");
  if (!/^\d+$/.test(input.poolId) || BigInt(input.poolId) <= BigInt(0)) throw new Error("A valid pool ID is required");
  if (!input.denomIn || !input.denomOut || input.denomIn === input.denomOut) throw new Error("Use two different native token denoms");
  if (!isPositiveInteger(input.amountIn)) throw new Error("Swap amount must be a positive integer");
  if (!isPositiveInteger(input.amountOut)) throw new Error("Receive amount must be a positive integer");
  if (!isPositiveInteger(input.maxIn)) throw new Error("A maximum input is required");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_QWAKK_INTERFACE_FEE_BPS) throw new Error(`Interface fee must be between 0 and ${MAX_QWAKK_INTERFACE_FEE_BPS} bps`);

  const totalAmount = BigInt(input.amountIn);
  const interfaceFee = (totalAmount * BigInt(feeBps)) / BigInt(10_000);
  const swapAmount = totalAmount - interfaceFee;
  if (swapAmount <= BigInt(0)) throw new Error(`Swap amount is too small after the ${BRAND.name} fee`);
  const maxIn = BigInt(input.maxIn);
  const ceiling = (swapAmount * BigInt(10_000 + MAX_EXACT_OUT_PADDING_BPS) + BigInt(9_999)) / BigInt(10_000);
  if (maxIn < swapAmount || maxIn > ceiling) throw new Error("The maximum input does not match the quote");

  const messages: EncodeObject[] = [];
  if (input.fee && interfaceFee > BigInt(0)) {
    messages.push(bank.send({
      fromAddress: input.sender,
      toAddress: input.fee.recipient,
      amount: [{ denom: input.denomIn, amount: interfaceFee.toString() }],
    }));
  }
  messages.push(amm.swapExactOut({
    sender: input.sender,
    poolId: input.poolId,
    denomIn: input.denomIn,
    tokenOut: { denom: input.denomOut, amount: input.amountOut },
    maxIn: maxIn.toString(),
  }));

  return {
    swapAmount: swapAmount.toString(),
    maxIn: maxIn.toString(),
    interfaceFee: { denom: input.denomIn, amount: interfaceFee.toString() },
    messages,
  };
}
