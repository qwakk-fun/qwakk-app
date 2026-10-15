import { amm, type EncodeObject } from "@qorechain/sdk";

type AddLiquidityInput = {
  action: "add";
  sender: string;
  poolId: string;
  denomA: string;
  amountA: string;
  denomB: string;
  amountB: string;
  minLpOut: string;
};

type RemoveLiquidityInput = {
  action: "remove";
  sender: string;
  poolId: string;
  lpAmount: string;
  minAmountA: string;
  minAmountB: string;
};

export type LiquidityRouteInput = AddLiquidityInput | RemoveLiquidityInput;
export type LiquidityRoutePlan = { action: LiquidityRouteInput["action"]; message: EncodeObject };

function isQoreAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/i.test(value);
}

function isDenom(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9/._:-]{1,127}$/.test(value);
}

function isPositiveInteger(value: string) {
  return /^\d+$/.test(value) && BigInt(value) > BigInt(0);
}

function isNonNegativeInteger(value: string) {
  return /^\d+$/.test(value);
}

/**
 * Puts a deposit in the pool's own token order (token_a, token_b). The
 * remove-liquidity minimums are always per pool side, so only deposits need
 * this. Null when the deposit does not match the pool's two tokens.
 */
export function alignDepositToPool<T extends { denomA: string; amountA: string; denomB: string; amountB: string }>(deposit: T, pool: { tokenA: string; tokenB: string }): T | null {
  if (deposit.denomA === pool.tokenA && deposit.denomB === pool.tokenB) return deposit;
  if (deposit.denomA === pool.tokenB && deposit.denomB === pool.tokenA) {
    return { ...deposit, denomA: deposit.denomB, amountA: deposit.amountB, denomB: deposit.denomA, amountB: deposit.amountA };
  }
  return null;
}

export function buildLiquidityRoute(input: LiquidityRouteInput): LiquidityRoutePlan {
  if (!isQoreAddress(input.sender)) throw new Error("A valid QoreChain sender address is required");
  if (!isPositiveInteger(input.poolId)) throw new Error("A valid pool ID is required");

  if (input.action === "add") {
    if (!isDenom(input.denomA) || !isDenom(input.denomB) || input.denomA === input.denomB) {
      throw new Error("Use two different native token denoms");
    }
    if (!isPositiveInteger(input.amountA) || !isPositiveInteger(input.amountB)) {
      throw new Error("Liquidity amounts must be positive integers");
    }
    // The chain accepts 0, which would mean no protection at all. Qwakk never sends it.
    if (!isPositiveInteger(input.minLpOut)) throw new Error("This deposit is too small for the pool");

    return {
      action: input.action,
      message: amm.addLiquidity({
        sender: input.sender,
        poolId: input.poolId,
        amountA: { denom: input.denomA, amount: input.amountA },
        amountB: { denom: input.denomB, amount: input.amountB },
        minLpOut: input.minLpOut,
      }),
    };
  }

  if (!isPositiveInteger(input.lpAmount)) throw new Error("LP amount must be a positive integer");
  if (!isNonNegativeInteger(input.minAmountA) || !isNonNegativeInteger(input.minAmountB)) {
    throw new Error("Minimum withdrawal amounts must be integers");
  }
  if (BigInt(input.minAmountA) + BigInt(input.minAmountB) <= BigInt(0)) throw new Error("This withdrawal is too small for the pool");

  return {
    action: input.action,
    message: amm.removeLiquidity({
      sender: input.sender,
      poolId: input.poolId,
      lpAmount: input.lpAmount,
      minAmountA: input.minAmountA,
      minAmountB: input.minAmountB,
    }),
  };
}
