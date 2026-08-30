import { amm, type EncodeObject } from "@qorechain/sdk";

export type CreatePoolInput = {
  creator: string;
  poolType: "constant_product" | "stable_swap";
  denomA: string;
  amountA: string;
  denomB: string;
  amountB: string;
  amplificationCoefficient?: number;
};

export type CreatePoolPlan = {
  message: EncodeObject;
  poolType: CreatePoolInput["poolType"];
};

function isQoreAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(value);
}

function isDenom(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9/._:-]{1,127}$/.test(value);
}

function isPositiveInteger(value: string) {
  return /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

/**
 * Builds the native x/amm create-pool message without signing or broadcasting.
 * The connected wallet remains the only actor able to approve the transaction.
 */
export function buildCreatePoolPlan(input: CreatePoolInput): CreatePoolPlan {
  if (!isQoreAddress(input.creator)) throw new Error("A valid QoreChain creator address is required");
  if (input.poolType !== "constant_product" && input.poolType !== "stable_swap") throw new Error("Choose a supported pool type");
  if (!isDenom(input.denomA) || !isDenom(input.denomB)) throw new Error("Use valid native token denoms");
  if (input.denomA === input.denomB) throw new Error("Choose two different tokens");
  if (!isPositiveInteger(input.amountA) || !isPositiveInteger(input.amountB)) throw new Error("Initial liquidity amounts must be positive integers");

  const amplificationCoefficient = input.poolType === "stable_swap"
    ? input.amplificationCoefficient ?? 200
    : 0;
  if (!Number.isInteger(amplificationCoefficient) || amplificationCoefficient < 0 || amplificationCoefficient > 1_000_000) {
    throw new Error("Use a valid amplification setting");
  }
  if (input.poolType === "stable_swap" && amplificationCoefficient === 0) {
    throw new Error("Stable pools need an amplification setting");
  }

  return {
    poolType: input.poolType,
    message: amm.createPool({
      creator: input.creator,
      poolType: input.poolType,
      initialDepositA: { denom: input.denomA, amount: input.amountA },
      initialDepositB: { denom: input.denomB, amount: input.amountB },
      amplificationCoefficient,
    }),
  };
}
