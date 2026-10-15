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
  /** The deposits in the order the chain stores them: denomA < denomB. */
  depositA: { denom: string; amount: string };
  depositB: { denom: string; amount: string };
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
 * Orders two deposits the way x/amm stores a pool: lexicographically by denom,
 * token_a < token_b (`x/amm/types/pool.go` SortedDenomTuple, byte order). Each
 * amount stays with its own denom.
 */
export function sortDeposits(a: { denom: string; amount: string }, b: { denom: string; amount: string }) {
  return a.denom < b.denom ? [a, b] as const : [b, a] as const;
}

/**
 * Pre-checks a new pool against live AMM params so the trader sees the reason
 * before the wallet opens. Simulated on Diana (2026-10-15): `min_liquidity`
 * applies to each deposit on its own, inclusive (1000/1000 passes the check,
 * 1000/999 and 999/1000000 fail with "deposit below minimum liquidity").
 */
export function createPoolPrecheck(input: { amountA: string; amountB: string }, params: { minLiquidity: string; enabled: boolean }): "below_min_liquidity" | "module_disabled" | null {
  if (!params.enabled) return "module_disabled";
  const min = BigInt(params.minLiquidity);
  if (BigInt(input.amountA) < min || BigInt(input.amountB) < min) return "below_min_liquidity";
  return null;
}

/**
 * Builds the native x/amm create-pool message without signing or broadcasting.
 * The connected wallet remains the only actor able to approve the transaction.
 * Deposits are sent in the chain's sorted order, so the message reads the same
 * as the pool it creates.
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
  if (!Number.isInteger(amplificationCoefficient) || amplificationCoefficient < 0 || amplificationCoefficient > 5_000) {
    throw new Error("Use a valid amplification setting");
  }
  if (input.poolType === "stable_swap" && amplificationCoefficient === 0) {
    throw new Error("Stable pools need an amplification setting");
  }

  const [depositA, depositB] = sortDeposits({ denom: input.denomA, amount: input.amountA }, { denom: input.denomB, amount: input.amountB });
  return {
    poolType: input.poolType,
    depositA,
    depositB,
    message: amm.createPool({
      creator: input.creator,
      poolType: input.poolType,
      initialDepositA: depositA,
      initialDepositB: depositB,
      amplificationCoefficient,
    }),
  };
}
