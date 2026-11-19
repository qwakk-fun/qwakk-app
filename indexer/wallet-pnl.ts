/**
 * Wallet cost basis and profit and loss (GET /pnl/:address): the database
 * reads around the pure engine in cost-basis.ts. The database, the indexer
 * state and the bank balance read are passed in, so the real queries can run
 * against any PostgreSQL (the server's pool, or an in-process one in a check).
 */

import {
  buildLedger, chooseQorPools, historicalRatio, historyWindow, isRatio, qorPoolLowLiquidity, ratioFromReserves, ratioFromTrade, valuePortfolio, QOR_DENOM,
  type CostBasisSwap, type Ratio, type TokenMeta, type TokenPrice,
} from "./cost-basis";
import { knownDecimals } from "./market-math";
import { minTvlFor } from "./token-registry";

/** indexer_state key holding the first block a fresh database indexed. Older databases do not have it. */
export const HISTORY_START_KEY = "history_start_height";

export type SqlQuery = <R>(text: string, params?: unknown[]) => Promise<{ rows: R[] }>;

export type WalletPnlDeps = {
  query: SqlQuery;
  getState: (key: string) => Promise<string | undefined>;
  /** Live bank balances, base units by denom (readBankBalances in production). */
  bankBalances: (address: string) => Promise<Map<string, string>>;
};

/** Swaps replayed per wallet. A wallet above this answers 422 instead of a partial replay. */
export const PNL_MAX_SWAPS = 50_000;
/** Distinct (pool, time) lookups for swaps between two non-QOR tokens. Later ones are valued as unknown. */
const PNL_MAX_PRICE_LOOKUPS = 2_000;

export class PnlTooLarge extends Error {}

/** Live bank balances of an address, base units by denom. */
export async function readBankBalances(restUrl: string, address: string) {
  const balances = new Map<string, string>();
  let key = "";
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ "pagination.limit": "500" });
    if (key) params.set("pagination.key", key);
    const response = await fetch(`${restUrl}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`QoreChain balance query failed with ${response.status}`);
    const data = await response.json() as { balances?: Array<{ denom?: string; amount?: string }>; pagination?: { next_key?: string | null } };
    for (const coin of Array.isArray(data.balances) ? data.balances : []) {
      if (coin.denom && /^\d+$/.test(coin.amount ?? "")) balances.set(coin.denom, coin.amount as string);
    }
    const next = data.pagination?.next_key ?? "";
    if (!next || next === key) break;
    key = next;
  }
  return balances;
}

async function pnlHistory(deps: WalletPnlDeps) {
  // State keys are read one after another so a /pnl request holds few pool
  // connections at once and block ingestion is not starved.
  const start = await deps.getState(HISTORY_START_KEY);
  const gap = await deps.getState("pruned_gap");
  const indexed = await deps.getState("last_indexed_height");
  const [earliest] = await Promise.all([
    // Two index scans instead of one scan over a union. The outer ORDER BY names the
    // table column: a bare "height" would sort the height::text output column as text.
    deps.query<{ height: string | null; executed_at: Date | null }>(
      `SELECT height::text, executed_at FROM (
         (SELECT height, executed_at FROM swaps ORDER BY height ASC LIMIT 1)
         UNION ALL
         (SELECT height, executed_at FROM liquidity_events ORDER BY height ASC LIMIT 1)
       ) first_events ORDER BY first_events.height ASC LIMIT 1`,
    ),
  ]);
  const row = earliest.rows[0];
  const number = (value: string | null | undefined) => (value && /^\d+$/.test(value) ? Number(value) : null);
  return historyWindow({
    startHeight: number(start),
    earliestEventHeight: number(row?.height),
    earliestEventTime: row?.executed_at ? row.executed_at.toISOString() : null,
    prunedGap: gap ?? null,
    indexedHeight: number(indexed),
  });
}

/**
 * Cost basis and profit and loss of one wallet, valued in QOR (indexer/cost-basis.ts).
 * Swaps come from the indexed amm_swap events (any interface, exact in and
 * exact out); balances are read live from the bank module.
 */
export async function walletPnl(address: string, deps: WalletPnlDeps) {
  const [swaps, balances, qorPools, history, tokens] = await Promise.all([
    deps.query<{ executed_at: string; denom_in: string; amount_in: string; denom_out: string; amount_out: string }>(
      `SELECT executed_at::text, denom_in, amount_in::text, denom_out, amount_out::text
       FROM swaps WHERE sender = $1 ORDER BY height ASC, id ASC LIMIT $2`,
      [address, PNL_MAX_SWAPS + 1],
    ),
    deps.bankBalances(address),
    deps.query<{ id: string; pool_type: string; token_a: string; token_b: string; reserve_a: string | null; reserve_b: string | null }>(
      `SELECT p.id::text, p.pool_type, p.token_a, p.token_b, snapshot.reserve_a::text, snapshot.reserve_b::text
       FROM pools p
       LEFT JOIN LATERAL (SELECT reserve_a, reserve_b FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
       WHERE (p.token_a = $1 OR p.token_b = $1) AND p.token_a <> p.token_b`,
      [QOR_DENOM],
    ),
    pnlHistory(deps),
    // Every token row: the table is small, and pool liquidity needs both sides' decimals.
    deps.query<{ denom: string; symbol: string; decimals: number | null }>("SELECT denom, symbol, decimals FROM tokens"),
  ]);
  if (swaps.rows.length > PNL_MAX_SWAPS) throw new PnlTooLarge();

  const meta = new Map<string, TokenMeta>(tokens.rows.map((row) => [row.denom, { symbol: row.symbol, decimals: knownDecimals(row.decimals) }]));
  const poolType = new Map(qorPools.rows.map((row) => [row.id, row.pool_type]));
  /** The markets page's low-liquidity rule for a QOR pool at the given reserves. */
  const lowLiquidityAt = (poolId: string, tokenA: string, tokenB: string, reserveA: string | null, reserveB: string | null) => qorPoolLowLiquidity({
    poolType: poolType.get(poolId) ?? "constant_product",
    tokenA,
    tokenB,
    reserveA,
    reserveB,
    decimalsA: meta.get(tokenA)?.decimals ?? null,
    decimalsB: meta.get(tokenB)?.decimals ?? null,
    minTvl: minTvlFor(QOR_DENOM),
  });
  const pools = chooseQorPools(qorPools.rows.map((row) => ({
    id: row.id,
    tokenA: row.token_a,
    tokenB: row.token_b,
    reserveA: row.reserve_a,
    reserveB: row.reserve_b,
    lowLiquidity: lowLiquidityAt(row.id, row.token_a, row.token_b, row.reserve_a, row.reserve_b),
  })));
  const denoms = new Set<string>([...balances.keys(), ...swaps.rows.flatMap((row) => [row.denom_in, row.denom_out])]);
  denoms.add(QOR_DENOM);

  // Swaps between two non-QOR tokens need a QOR price at swap time for one side: the input first.
  const lookups = new Map<string, { poolId: string; at: string }>();
  const lookupKey = (poolId: string, at: string) => `${poolId}|${at}`;
  for (const row of swaps.rows) {
    if (row.denom_in === QOR_DENOM || row.denom_out === QOR_DENOM) continue;
    for (const denom of [row.denom_in, row.denom_out]) {
      const pool = pools.get(denom);
      if (!pool) continue;
      const key = lookupKey(pool.id, row.executed_at);
      if (!lookups.has(key) && lookups.size < PNL_MAX_PRICE_LOOKUPS) lookups.set(key, { poolId: pool.id, at: row.executed_at });
    }
  }

  const relevantPools = [...denoms].flatMap((denom) => pools.get(denom)?.id ?? []);
  const [latestTrades, pastPrices] = await Promise.all([
    deps.query<{ pool_id: string; denom_in: string | null; amount_in: string | null; denom_out: string | null; amount_out: string | null }>(
      `SELECT q.id::text AS pool_id, t.denom_in, t.amount_in::text, t.denom_out, t.amount_out::text
       FROM unnest($1::bigint[]) AS q(id)
       LEFT JOIN LATERAL (SELECT denom_in, amount_in, denom_out, amount_out FROM swaps WHERE pool_id = q.id ORDER BY executed_at DESC, id DESC LIMIT 1) t ON true`,
      [relevantPools],
    ),
    lookups.size ? deps.query<{
      pool_id: string; at: string; denom_in: string | null; amount_in: string | null; denom_out: string | null; amount_out: string | null;
      reserve_a: string | null; reserve_b: string | null; snapshot_newer: boolean | null;
    }>(
      // The time strings are the swaps' own executed_at::text, so each answer row keys back to its lookup.
      `SELECT q.pool_id::text, q.at_text AS at, t.denom_in, t.amount_in::text, t.denom_out, t.amount_out::text,
              sn.reserve_a::text, sn.reserve_b::text, (sn.observed_at > t.executed_at) AS snapshot_newer
       FROM unnest($1::bigint[], $2::text[]) AS q(pool_id, at_text)
       LEFT JOIN LATERAL (
         SELECT denom_in, amount_in, denom_out, amount_out, executed_at FROM swaps
         WHERE pool_id = q.pool_id AND executed_at <= q.at_text::timestamptz ORDER BY executed_at DESC, id DESC LIMIT 1
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT reserve_a, reserve_b, observed_at FROM pool_snapshots
         WHERE pool_id = q.pool_id AND observed_at <= q.at_text::timestamptz ORDER BY observed_at DESC LIMIT 1
       ) sn ON true`,
      [[...lookups.values()].map((lookup) => lookup.poolId), [...lookups.values()].map((lookup) => lookup.at)],
    ) : Promise.resolve({ rows: [] }),
  ]);

  const trade = (row: { denom_in: string | null; amount_in: string | null; denom_out: string | null; amount_out: string | null }) =>
    row.denom_in && row.amount_in && row.denom_out && row.amount_out ? { denomIn: row.denom_in, amountIn: row.amount_in, denomOut: row.denom_out, amountOut: row.amount_out } : null;

  const past = new Map(pastPrices.rows.map((row) => [lookupKey(row.pool_id, row.at), row]));
  const pastRatio = (denom: string, at: string): Ratio | null => {
    const pool = pools.get(denom);
    const row = pool ? past.get(lookupKey(pool.id, at)) : undefined;
    if (!pool || !row) return null;
    const reserves = row.reserve_a !== null && row.reserve_b !== null ? { tokenA: pool.tokenA, tokenB: pool.tokenB, reserveA: row.reserve_a, reserveB: row.reserve_b } : null;
    // The pool must not have been low liquidity at that time, judged on its last snapshot then.
    // Without a snapshot nothing can tell, so the price stays unknown.
    const usable = reserves !== null && !lowLiquidityAt(pool.id, pool.tokenA, pool.tokenB, reserves.reserveA, reserves.reserveB);
    return historicalRatio(denom, trade(row), reserves, row.snapshot_newer === true, usable);
  };

  const replay: CostBasisSwap[] = swaps.rows.map((row) => {
    const crossPair = row.denom_in !== QOR_DENOM && row.denom_out !== QOR_DENOM;
    return {
      denomIn: row.denom_in,
      amountIn: row.amount_in,
      denomOut: row.denom_out,
      amountOut: row.amount_out,
      priceIn: crossPair ? pastRatio(row.denom_in, row.executed_at) : null,
      priceOut: crossPair ? pastRatio(row.denom_out, row.executed_at) : null,
    };
  });

  // Current price: the pool's last trade, else its reserves, as on the markets page.
  const lastTrade = new Map(latestTrades.rows.map((row) => [row.pool_id, trade(row)]));
  const prices = new Map<string, TokenPrice>();
  for (const denom of denoms) {
    const pool = pools.get(denom);
    if (!pool) continue;
    const reserves = { tokenA: pool.tokenA, tokenB: pool.tokenB, reserveA: pool.reserveA, reserveB: pool.reserveB };
    const fromTrade = ratioFromTrade(denom, lastTrade.get(pool.id) ?? null);
    const ratio = fromTrade ?? ratioFromReserves(denom, reserves);
    if (!isRatio(ratio)) continue;
    // A low-liquidity pool's price is reported for display but never values anything (valuePortfolio).
    prices.set(denom, { ratio, poolId: pool.id, source: fromTrade ? "last_trade" : "spot", lowLiquidity: pool.lowLiquidity !== false });
  }

  const { tokens: pnlTokens, totals } = valuePortfolio({ ledger: buildLedger(replay), balances, prices, meta });
  return {
    address,
    method: "average_cost",
    unit: { denom: QOR_DENOM, symbol: "QOR", decimals: 6 },
    history,
    swapsCounted: swaps.rows.length,
    totals,
    tokens: pnlTokens,
  };
}
