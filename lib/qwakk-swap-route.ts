import { amm, bank, type EncodeObject } from "@qorechain/sdk";

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
  if (!/^\d+$/.test(input.minOut)) throw new Error("Minimum output must be an integer");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_QWAKK_INTERFACE_FEE_BPS) throw new Error(`Interface fee must be between 0 and ${MAX_QWAKK_INTERFACE_FEE_BPS} bps`);

  const totalAmount = BigInt(input.amountIn);
  const interfaceFee = (totalAmount * BigInt(feeBps)) / BigInt(10_000);
  const swapAmount = totalAmount - interfaceFee;
  if (swapAmount <= BigInt(0)) throw new Error("Swap amount is too small after the interface fee");

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
