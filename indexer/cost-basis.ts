/**
 * Per-token cost basis and profit and loss of one wallet, valued in QOR.
 *
 * Method: average cost, replayed over the wallet's indexed swaps in chain
 * order. Every amount is an integer in base units and every QOR value is an
 * integer in uqor (BigInt), so totals are exact sums. Prices are exact
 * rationals (uqor per base unit) and a value is truncated to whole uqor only
 * once, where it is computed.
 *
 * Rules:
 * - A swap with QOR on one side is valued by its QOR side, exactly.
 * - A swap between two other tokens is valued in QOR through the input
 *   token's QOR pool price at swap time, else the output token's. Without
 *   either the swap's value is unknown: the bought side gets unknown cost and
 *   the sold side gets unknown proceeds. Nothing is guessed.
 * - Buying adds to the position. When the value is unknown the bought units
 *   go into a separate unknown-cost bucket instead of the average.
 * - Selling takes from the known-cost and unknown-cost buckets in proportion
 *   (average cost over the whole position). Realized PnL is only booked on
 *   the known-cost part with known proceeds. Units sold beyond the position
 *   (bought before indexed history, received by transfer, faucet or LP
 *   withdrawal) have no cost basis and book nothing.
 * - Holdings are reconciled against the live bank balance: units held beyond
 *   the swap position have unknown cost; when less is held than the swap
 *   position (sent away or added to a pool), the held amount keeps the
 *   position's known/unknown proportion and average cost, and the difference
 *   is reported as untracked outflow, never as a sale.
 * - QOR itself is the unit of account, so it has no position of its own.
 */

import { dustThreshold } from "./market-math";

export const QOR_DENOM = "uqor";
export const QOR_DECIMALS = 6;

/** Exact price: `num` uqor per `den` base units of the token. Both positive. */
export type Ratio = { num: bigint; den: bigint };

export type CostBasisSwap = {
  denomIn: string;
  amountIn: string;
  denomOut: string;
  amountOut: string;
  /** QOR price of denomIn at swap time, only needed when neither side is QOR. */
  priceIn?: Ratio | null;
  /** QOR price of denomOut at swap time, only needed when neither side is QOR. */
  priceOut?: Ratio | null;
};

export type LedgerEntry = {
  denom: string;
  /** Base units received and sent through swaps. */
  bought: bigint;
  sold: bigint;
  buys: number;
  sells: number;
  /** Open swap position with known cost, and its cost in uqor. */
  knownQty: bigint;
  knownCost: bigint;
  /** Open swap position bought at an unknown QOR value. */
  unknownQty: bigint;
  /** Realized PnL in uqor, booked on known cost and known proceeds only. */
  realizedPnl: bigint;
  /** Base units sold whose PnL was booked. */
  realizedQty: bigint;
  /** Base units sold whose cost or proceeds are unknown (no PnL booked). */
  realizedUnknownQty: bigint;
};

const ZERO = BigInt(0);
const TEN = BigInt(10);
const DIGITS = /^\d+$/;

function amount(value: string) {
  if (!DIGITS.test(value)) throw new Error("Amounts must be non-negative integers");
  return BigInt(value);
}

export function isRatio(value: Ratio | null | undefined): value is Ratio {
  return Boolean(value) && (value as Ratio).num > ZERO && (value as Ratio).den > ZERO;
}

/** Base units times a QOR price, truncated to whole uqor. */
export function valueInUqor(baseUnits: bigint, price: Ratio) {
  return (baseUnits * price.num) / price.den;
}

/**
 * QOR price of `denom` from one trade or one reserve pair of a QOR pool:
 * the uqor side over the token side. Null when the pair is not token/QOR or a
 * side is zero.
 */
export function qorRatio(denom: string, sides: Array<{ denom: string; amount: string | null }>): Ratio | null {
  if (denom === QOR_DENOM) return null;
  const qor = sides.find((side) => side.denom === QOR_DENOM);
  const token = sides.find((side) => side.denom === denom);
  if (!qor || !token || !DIGITS.test(qor.amount ?? "") || !DIGITS.test(token.amount ?? "")) return null;
  const ratio = { num: BigInt(qor.amount as string), den: BigInt(token.amount as string) };
  return isRatio(ratio) ? ratio : null;
}

function entryFor(ledger: Map<string, LedgerEntry>, denom: string) {
  let entry = ledger.get(denom);
  if (!entry) {
    entry = { denom, bought: ZERO, sold: ZERO, buys: 0, sells: 0, knownQty: ZERO, knownCost: ZERO, unknownQty: ZERO, realizedPnl: ZERO, realizedQty: ZERO, realizedUnknownQty: ZERO };
    ledger.set(denom, entry);
  }
  return entry;
}

function applyBuy(entry: LedgerEntry, quantity: bigint, cost: bigint | null) {
  entry.bought += quantity;
  entry.buys += 1;
  if (cost === null) entry.unknownQty += quantity;
  else {
    entry.knownQty += quantity;
    entry.knownCost += cost;
  }
}

function applySell(entry: LedgerEntry, quantity: bigint, proceeds: bigint | null) {
  entry.sold += quantity;
  entry.sells += 1;
  const position = entry.knownQty + entry.unknownQty;
  const covered = quantity < position ? quantity : position;
  // Proportional split; a full exit takes exactly the whole known bucket.
  const fromKnown = position > ZERO ? (covered * entry.knownQty) / position : ZERO;
  const fromUnknown = covered - fromKnown;
  const costRemoved = entry.knownQty > ZERO ? (entry.knownCost * fromKnown) / entry.knownQty : ZERO;
  entry.knownQty -= fromKnown;
  entry.knownCost -= costRemoved;
  entry.unknownQty -= fromUnknown;
  if (fromKnown > ZERO && proceeds !== null) {
    entry.realizedPnl += (proceeds * fromKnown) / quantity - costRemoved;
    entry.realizedQty += fromKnown;
  } else {
    entry.realizedUnknownQty += fromKnown;
  }
  entry.realizedUnknownQty += quantity - covered + fromUnknown;
}

/** QOR value of a swap: its QOR side, else the input or output token at its swap-time QOR price. */
export function swapValueUqor(swap: CostBasisSwap): bigint | null {
  if (swap.denomIn === QOR_DENOM) return amount(swap.amountIn);
  if (swap.denomOut === QOR_DENOM) return amount(swap.amountOut);
  if (isRatio(swap.priceIn)) return valueInUqor(amount(swap.amountIn), swap.priceIn);
  if (isRatio(swap.priceOut)) return valueInUqor(amount(swap.amountOut), swap.priceOut);
  return null;
}

/** Replays swaps (oldest first) into one ledger entry per non-QOR token. */
export function buildLedger(swaps: CostBasisSwap[]) {
  const ledger = new Map<string, LedgerEntry>();
  for (const swap of swaps) {
    if (swap.denomIn === swap.denomOut) continue;
    const amountIn = amount(swap.amountIn);
    const amountOut = amount(swap.amountOut);
    if (amountIn === ZERO || amountOut === ZERO) continue;
    const value = swapValueUqor(swap);
    if (swap.denomIn !== QOR_DENOM) applySell(entryFor(ledger, swap.denomIn), amountIn, value);
    if (swap.denomOut !== QOR_DENOM) applyBuy(entryFor(ledger, swap.denomOut), amountOut, value);
  }
  return ledger;
}

/** A signed scaled integer as a plain decimal string, without trailing zeros. */
export function formatScaled(value: bigint, scale: number) {
  const negative = value < ZERO;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? digits.slice(digits.length - scale).replace(/0+$/, "") : "";
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}

/** Price digits kept for per-token QOR prices and average costs. */
export const PRICE_DIGITS = 18;

/** QOR per one whole token for a uqor-per-base-unit ratio, truncated. Null without decimals. */
export function qorPerToken(num: bigint, den: bigint, decimals: number | null) {
  if (decimals === null || den <= ZERO) return null;
  return formatScaled((num * TEN ** BigInt(decimals + PRICE_DIGITS)) / (den * TEN ** BigInt(QOR_DECIMALS)), PRICE_DIGITS);
}

/** pnl / cost in percent, 2 decimals, truncated toward zero. Null when cost is zero. */
export function pnlPercent(pnl: bigint, cost: bigint) {
  if (cost <= ZERO) return null;
  return formatScaled((pnl * BigInt(10_000)) / cost, 2);
}

export type TokenPrice = {
  ratio: Ratio;
  poolId: string;
  source: "last_trade" | "spot";
  lowLiquidity: boolean;
};

export type TokenMeta = { symbol: string | null; decimals: number | null };

export type CostCoverage = "complete" | "partial" | "none";

export type TokenPnl = {
  denom: string;
  symbol: string | null;
  decimals: number | null;
  /** Live bank balance, base units. */
  held: string;
  bought: string;
  sold: string;
  buys: number;
  sells: number;
  /** Held base units with a known cost, their cost in uqor and the average cost (QOR per token). */
  costBasisAmount: string;
  costBasisUqor: string;
  averageCostQor: string | null;
  /** Held base units without a known cost: never part of PnL. */
  unknownCostAmount: string;
  /** Swap position no longer in the wallet (sent away, added to a pool, paid as a fee). Not a sale. */
  untrackedOutflowAmount: string;
  price: { qorPerToken: string | null; poolId: string; source: "last_trade" | "spot"; lowLiquidity: boolean } | null;
  /** Whole held balance at the current price, uqor. Null without a price. */
  valueUqor: string | null;
  /** Value minus cost of the known-cost part only, uqor. Null without a price or known-cost holdings. */
  unrealizedPnlUqor: string | null;
  unrealizedPnlPercent: string | null;
  realizedPnlUqor: string;
  /** Sold base units whose PnL could not be booked (unknown cost or unknown proceeds). */
  realizedUnknownAmount: string;
  costCoverage: CostCoverage;
  dust: boolean;
};

export type PnlTotals = {
  /** Sum over priced tokens. */
  valueUqor: string;
  /** Cost of the known-cost holdings of priced tokens; the base of the unrealized percent. */
  costBasisUqor: string;
  unrealizedPnlUqor: string;
  unrealizedPnlPercent: string | null;
  realizedPnlUqor: string;
  /** Tokens held without a current QOR price; their value is not in the totals. */
  unpricedTokens: number;
  /**
   * complete: every holding and every sale has a known cost and every holding is priced.
   * partial: some of it is known. none: nothing has a known cost (including an empty wallet).
   */
  coverage: CostCoverage;
};

function coverageOf(knownHeld: bigint, unknownHeld: bigint, realizedQty: bigint, realizedUnknown: bigint): CostCoverage {
  if (unknownHeld === ZERO && realizedUnknown === ZERO) return "complete";
  if (knownHeld > ZERO || realizedQty > ZERO) return "partial";
  return "none";
}

/**
 * Values the ledger against live balances and current prices. `balances`
 * maps denom to held base units; QOR and zero balances without swap history
 * are skipped. Tokens are sorted by value, largest first, unpriced last.
 */
export function valuePortfolio(input: {
  ledger: Map<string, LedgerEntry>;
  balances: Map<string, string>;
  prices: Map<string, TokenPrice>;
  meta: Map<string, TokenMeta>;
}) {
  const denoms = new Set<string>(input.ledger.keys());
  for (const [denom, held] of input.balances) if (DIGITS.test(held) && BigInt(held) > ZERO) denoms.add(denom);
  denoms.delete(QOR_DENOM);

  const rows: Array<{ token: TokenPnl; value: bigint | null }> = [];
  let totalValue = ZERO;
  let totalCost = ZERO;
  let totalUnrealized = ZERO;
  let totalRealized = ZERO;
  let unpricedTokens = 0;
  let coverage: CostCoverage = "complete";
  let anyKnown = false;

  for (const denom of denoms) {
    const entry = input.ledger.get(denom) ?? entryFor(new Map(), denom);
    const balance = input.balances.get(denom) ?? "0";
    const held = DIGITS.test(balance) ? BigInt(balance) : ZERO;
    const meta = input.meta.get(denom) ?? { symbol: null, decimals: null };
    const tracked = entry.knownQty + entry.unknownQty;

    let knownHeld: bigint;
    let knownCost: bigint;
    let untrackedOutflow = ZERO;
    if (held >= tracked) {
      knownHeld = entry.knownQty;
      knownCost = entry.knownCost;
    } else {
      untrackedOutflow = tracked - held;
      knownHeld = (held * entry.knownQty) / tracked;
      knownCost = entry.knownQty > ZERO ? (entry.knownCost * knownHeld) / entry.knownQty : ZERO;
    }
    const unknownHeld = held - knownHeld;

    // Same rule as the markets page: a token without known decimals is unpriced.
    const price = meta.decimals === null ? undefined : input.prices.get(denom);
    const value = price && held > ZERO ? valueInUqor(held, price.ratio) : price ? ZERO : null;
    const knownValue = price ? valueInUqor(knownHeld, price.ratio) : null;
    const unrealized = knownValue !== null && knownHeld > ZERO ? knownValue - knownCost : null;
    const tokenCoverage = coverageOf(knownHeld, unknownHeld, entry.realizedQty, entry.realizedUnknownQty);

    if (held > ZERO && !price) unpricedTokens += 1;
    if (value !== null) totalValue += value;
    if (unrealized !== null) {
      totalUnrealized += unrealized;
      totalCost += knownCost;
    }
    totalRealized += entry.realizedPnl;
    if (tokenCoverage !== "complete") coverage = "partial";
    if (knownHeld > ZERO || entry.realizedQty > ZERO) anyKnown = true;

    rows.push({ value, token: {
      denom,
      symbol: meta.symbol,
      decimals: meta.decimals,
      held: held.toString(),
      bought: entry.bought.toString(),
      sold: entry.sold.toString(),
      buys: entry.buys,
      sells: entry.sells,
      costBasisAmount: knownHeld.toString(),
      costBasisUqor: knownCost.toString(),
      averageCostQor: knownHeld > ZERO ? qorPerToken(knownCost, knownHeld, meta.decimals) : null,
      unknownCostAmount: unknownHeld.toString(),
      untrackedOutflowAmount: untrackedOutflow.toString(),
      price: price ? { qorPerToken: qorPerToken(price.ratio.num, price.ratio.den, meta.decimals), poolId: price.poolId, source: price.source, lowLiquidity: price.lowLiquidity } : null,
      valueUqor: value === null ? null : value.toString(),
      unrealizedPnlUqor: unrealized === null ? null : unrealized.toString(),
      unrealizedPnlPercent: unrealized === null ? null : pnlPercent(unrealized, knownCost),
      realizedPnlUqor: entry.realizedPnl.toString(),
      realizedUnknownAmount: entry.realizedUnknownQty.toString(),
      costCoverage: tokenCoverage,
      dust: held > ZERO && meta.decimals !== null && held < dustThreshold(meta.decimals),
    } });
  }

  if (unpricedTokens > 0) coverage = "partial";
  // Nothing with a known cost (or nothing at all): there is no PnL to show.
  if (!anyKnown) coverage = "none";

  rows.sort((a, b) => {
    if (a.value === b.value) return a.token.denom.localeCompare(b.token.denom);
    if (a.value === null || b.value === null) return a.value === null ? 1 : -1;
    return a.value > b.value ? -1 : 1;
  });

  const totals: PnlTotals = {
    valueUqor: totalValue.toString(),
    costBasisUqor: totalCost.toString(),
    unrealizedPnlUqor: totalUnrealized.toString(),
    unrealizedPnlPercent: pnlPercent(totalUnrealized, totalCost),
    realizedPnlUqor: totalRealized.toString(),
    unpricedTokens,
    coverage,
  };
  return { tokens: rows.map((row) => row.token), totals };
}

export type QorPoolRow = { id: string; tokenA: string; tokenB: string; reserveA: string | null; reserveB: string | null };

/**
 * The QOR pool that prices each token: among the pools pairing it with QOR,
 * the one holding the most QOR in its latest snapshot (lowest id on a tie).
 * Pools without a snapshot count as empty.
 */
export function chooseQorPools(pools: QorPoolRow[]) {
  const chosen = new Map<string, { pool: QorPoolRow; qorReserve: bigint }>();
  for (const pool of pools) {
    const qorSide = pool.tokenA === QOR_DENOM ? "a" : pool.tokenB === QOR_DENOM ? "b" : null;
    if (!qorSide || pool.tokenA === pool.tokenB) continue;
    const token = qorSide === "a" ? pool.tokenB : pool.tokenA;
    const raw = qorSide === "a" ? pool.reserveA : pool.reserveB;
    const qorReserve = DIGITS.test(raw ?? "") ? BigInt(raw as string) : ZERO;
    const current = chosen.get(token);
    if (!current || qorReserve > current.qorReserve || (qorReserve === current.qorReserve && Number(pool.id) < Number(current.pool.id))) {
      chosen.set(token, { pool, qorReserve });
    }
  }
  return new Map([...chosen].map(([token, { pool }]) => [token, pool]));
}

export type TradeRow = { denomIn: string; amountIn: string; denomOut: string; amountOut: string };
export type ReservesRow = { tokenA: string; tokenB: string; reserveA: string | null; reserveB: string | null };

/** QOR price of `denom` from a trade in its QOR pool. */
export function ratioFromTrade(denom: string, trade: TradeRow | null) {
  return trade ? qorRatio(denom, [{ denom: trade.denomIn, amount: trade.amountIn }, { denom: trade.denomOut, amount: trade.amountOut }]) : null;
}

/** QOR price of `denom` from its QOR pool's reserves (spot). */
export function ratioFromReserves(denom: string, reserves: ReservesRow | null) {
  return reserves ? qorRatio(denom, [{ denom: reserves.tokenA, amount: reserves.reserveA }, { denom: reserves.tokenB, amount: reserves.reserveB }]) : null;
}

/**
 * QOR price of `denom` at a past swap: the newer of the pool's last trade and
 * its last reserve snapshot at or before that time, else whichever exists.
 */
export function historicalRatio(denom: string, trade: TradeRow | null, reserves: ReservesRow | null, snapshotIsNewer: boolean) {
  const fromTrade = ratioFromTrade(denom, trade);
  const fromReserves = ratioFromReserves(denom, reserves);
  return snapshotIsNewer ? fromReserves ?? fromTrade : fromTrade ?? fromReserves;
}

export type HistoryInput = {
  /** First block of indexing, recorded when the database started (absent on older databases). */
  startHeight: number | null;
  /** Earliest stored swap or liquidity event. */
  earliestEventHeight: number | null;
  earliestEventTime: string | null;
  /** indexer_state pruned_gap, "from-to". */
  prunedGap: string | null;
  indexedHeight: number | null;
};

/**
 * Where the wallet's indexed history starts. Older databases did not record
 * their start, so the earliest stored event stands in: every block from it on
 * is indexed, so the claim is conservative.
 */
export function historyWindow(input: HistoryInput) {
  const fromHeight = input.startHeight ?? input.earliestEventHeight;
  const gap = /^(\d+)-(\d+)$/.exec(input.prunedGap ?? "");
  return {
    fromHeight,
    fromTime: input.earliestEventTime,
    source: input.startHeight !== null ? "indexer_start" as const : input.earliestEventHeight !== null ? "earliest_event" as const : null,
    indexedHeight: input.indexedHeight,
    gap: gap ? { fromHeight: Number(gap[1]), toHeight: Number(gap[2]) } : null,
  };
}
