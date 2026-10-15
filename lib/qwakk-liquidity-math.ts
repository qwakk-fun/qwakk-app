/**
 * Liquidity estimates in integer base units. The AMM keeper is not public, so
 * these use the Uniswap V2 share rules the chain names for its constant-product
 * pools (qorechain-core CHANGELOG v2.23.0): LP minted is the smaller of the two
 * proportional shares, a withdrawal pays out reserves pro rata, both rounded
 * down. They only set minimums the user is protected by: if the chain mints
 * differently, the transaction is refused rather than settling worse than
 * shown. `scripts/qwakk-verify-amm.ts` compares them with the chain.
 */

const BPS = BigInt(10_000);

function toBig(value: string, name: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

export function applySlippage(amount: string, slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) throw new Error("Slippage must be between 0 and 5000 bps");
  return ((toBig(amount, "Amount") * (BPS - BigInt(slippageBps))) / BPS).toString();
}

/** The token B amount that keeps a deposit at the pool's current ratio. */
export function matchingDeposit(amountA: string, reserveA: string, reserveB: string) {
  const a = toBig(amountA, "Amount A");
  const ra = toBig(reserveA, "Reserve A");
  const rb = toBig(reserveB, "Reserve B");
  if (ra === BigInt(0)) return null;
  return ((a * rb) / ra).toString();
}

/** LP shares a deposit should mint into a pool that already has liquidity. */
export function expectedLpForDeposit(amountA: string, amountB: string, reserveA: string, reserveB: string, lpSupply: string) {
  const a = toBig(amountA, "Amount A");
  const b = toBig(amountB, "Amount B");
  const ra = toBig(reserveA, "Reserve A");
  const rb = toBig(reserveB, "Reserve B");
  const supply = toBig(lpSupply, "LP supply");
  if (ra === BigInt(0) || rb === BigInt(0) || supply === BigInt(0)) return null;
  const byA = (a * supply) / ra;
  const byB = (b * supply) / rb;
  return (byA < byB ? byA : byB).toString();
}

/** Token amounts returned for burning LP shares. */
export function expectedWithdrawal(lpAmount: string, reserveA: string, reserveB: string, lpSupply: string) {
  const lp = toBig(lpAmount, "LP amount");
  const supply = toBig(lpSupply, "LP supply");
  if (supply === BigInt(0) || lp > supply) return null;
  return {
    amountA: ((lp * toBig(reserveA, "Reserve A")) / supply).toString(),
    amountB: ((lp * toBig(reserveB, "Reserve B")) / supply).toString(),
  };
}

/** The share of the pool, in bps, that newly minted LP shares will hold. */
export function poolShareBps(lpMinted: string, lpSupply: string) {
  const minted = toBig(lpMinted, "LP minted");
  const total = toBig(lpSupply, "LP supply") + minted;
  if (total === BigInt(0)) return null;
  return Number((minted * BPS) / total);
}

/**
 * Whether `actual` is within `toleranceBps` of `expected`, either way. One base
 * unit of rounding is always tolerated.
 */
export function withinTolerance(actual: string, expected: string, toleranceBps: number) {
  const a = toBig(actual, "Actual");
  const e = toBig(expected, "Expected");
  const diff = a > e ? a - e : e - a;
  return diff <= BigInt(1) || diff * BPS <= e * BigInt(toleranceBps);
}
