/**
 * Opt-in rebuild of swap prices and candles from the raw swaps table.
 *
 * Swap prices and candles are derived from swap amounts and token decimals at
 * the time each swap was indexed. When a token's decimals change (a curated
 * fix, corrected chain metadata, or a token that was unknown becoming known)
 * the indexer does not rewrite anything; it lists the affected pools in
 * indexer_state.stale_candle_pools and logs a warning. This script is the
 * owner's choice to rebuild them. Raw swaps (amounts, denoms, heights) are
 * never changed; only swaps.price_b_per_a and the pool's candles of the
 * intervals in CANDLE_INTERVALS are rewritten (retired 6h rows are kept).
 *
 * Usage, from qwakk-app (or /app in the indexer container):
 *   npx tsx indexer/rebuild-candles.ts --stale            dry run for the pools the indexer flagged
 *   npx tsx indexer/rebuild-candles.ts --pools 1,4        dry run for chosen pools
 *   npx tsx indexer/rebuild-candles.ts --all              dry run for every pool with swaps
 *   add --apply to write the rebuild (one transaction per pool)
 * In the indexer container use `node --import tsx indexer/rebuild-candles.ts ...`.
 *
 * QWAKK_NETWORK must match the chain the database holds (indexer_state.chain_id),
 * because the curated token list and quote sides differ per network. A
 * database without that label is refused unless --assume-chain-id <chain id>
 * names it (it must match QWAKK_NETWORK).
 *
 * Stop the indexer before --apply: a swap indexed during the rebuild could be
 * counted twice in its candle. Back up the database first in production.
 * It reads DATABASE_URL like the indexer.
 */
import { Pool } from "pg";

import { applyTradeToCandles, CANDLE_INTERVALS, chooseQuoteSide, compareDecimal, knownDecimals, swapTrade, type Candle } from "./market-math";
import { databaseNetworkCheck, resolveIndexerNetwork } from "./indexer-config";
import { quoteRank } from "./token-registry";

const STALE_POOLS_KEY = "stale_candle_pools";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://qwakk:qwakk_local@localhost:5438/qwakk";

type SwapRow = { id: string; denom_in: string; amount_in: string; denom_out: string; amount_out: string; price_b_per_a: string | null; executed_at: Date };

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const all = argv.includes("--all");
  const stale = argv.includes("--stale");
  const poolsIndex = argv.indexOf("--pools");
  const pools = poolsIndex >= 0 ? (argv[poolsIndex + 1] ?? "").split(",").filter((id) => /^\d+$/.test(id)) : [];
  if ([all, stale, pools.length > 0].filter(Boolean).length !== 1) {
    throw new Error("Choose exactly one of --stale, --pools <ids> or --all (add --apply to write)");
  }
  const assumeIndex = argv.indexOf("--assume-chain-id");
  const assumed = assumeIndex >= 0 ? (argv[assumeIndex + 1] ?? "").trim() || null : null;
  return { apply, all, stale, pools, assumed };
}

function samePrice(stored: string | null, computed: string | null) {
  if (stored === null || computed === null) return stored === computed;
  try {
    return compareDecimal(stored, computed) === 0;
  } catch {
    return false;
  }
}

async function rebuildPool(db: Pool, poolId: string, apply: boolean) {
  const pool = (await db.query<{ token_a: string; token_b: string }>("SELECT token_a, token_b FROM pools WHERE id = $1", [poolId])).rows[0];
  if (!pool) return { poolId, status: "missing pool" };
  const tokens = await db.query<{ denom: string; decimals: number | null }>("SELECT denom, decimals FROM tokens WHERE denom = ANY($1)", [[pool.token_a, pool.token_b, "uqor"]]);
  const decimals = new Map(tokens.rows.map((row) => [row.denom, knownDecimals(row.decimals)]));
  const decimalsA = decimals.get(pool.token_a) ?? null;
  const decimalsB = decimals.get(pool.token_b) ?? null;
  if (decimalsA === null || decimalsB === null) return { poolId, status: "skipped: a token has unknown decimals" };

  const info = {
    tokenA: pool.token_a,
    tokenB: pool.token_b,
    decimalsA,
    decimalsB,
    qorDecimals: decimals.get("uqor") ?? 6,
    quoteSide: chooseQuoteSide(quoteRank(pool.token_a), quoteRank(pool.token_b)),
  };
  // Same order the indexer recorded them: block by block, then insertion order.
  const swaps = await db.query<SwapRow>(
    "SELECT id::text, denom_in, amount_in::text, denom_out, amount_out::text, price_b_per_a::text, executed_at FROM swaps WHERE pool_id = $1 ORDER BY height ASC, id ASC",
    [poolId],
  );
  const candles = new Map<string, Candle>();
  const priceUpdates: Array<{ id: string; price: string | null }> = [];
  for (const swap of swaps.rows) {
    const trade = swapTrade({ denomIn: swap.denom_in, amountIn: swap.amount_in, denomOut: swap.denom_out, amountOut: swap.amount_out }, info);
    if (!samePrice(swap.price_b_per_a, trade.price)) priceUpdates.push({ id: swap.id, price: trade.price });
    if (trade.price !== null) applyTradeToCandles(candles, swap.executed_at, trade.price, trade.volumeQor, trade.volumeQuote);
  }
  const existing = Number((await db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM candles WHERE pool_id = $1 AND interval = ANY($2)", [poolId, Object.keys(CANDLE_INTERVALS)])).rows[0]?.count ?? 0);
  const summary = { poolId, swaps: swaps.rowCount ?? 0, swapPricesChanged: priceUpdates.length, candlesBefore: existing, candlesAfter: candles.size };
  if (!apply) return { ...summary, status: "dry run" };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const update of priceUpdates) await client.query("UPDATE swaps SET price_b_per_a = $2 WHERE id = $1", [update.id, update.price]);
    // Only the intervals the indexer writes are rebuilt; rows of retired intervals (6h) are kept as they are.
    await client.query("DELETE FROM candles WHERE pool_id = $1 AND interval = ANY($2)", [poolId, Object.keys(CANDLE_INTERVALS)]);
    for (const candle of candles.values()) {
      await client.query(
        `INSERT INTO candles (pool_id, interval, start_time, open, high, low, close, volume_qor, volume_quote, transactions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [poolId, candle.interval, candle.startTime, candle.open, candle.high, candle.low, candle.close, candle.volumeQor, candle.volumeQuote ?? null, candle.transactions],
      );
    }
    const stale = (await client.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = $1 FOR UPDATE", [STALE_POOLS_KEY])).rows[0]?.value;
    if (stale !== undefined) {
      const remaining = stale.split(",").filter((id) => /^\d+$/.test(id) && id !== poolId).join(",");
      await client.query("UPDATE indexer_state SET value = $2, updated_at = NOW() WHERE key = $1", [STALE_POOLS_KEY, remaining]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { ...summary, status: "rebuilt" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { network } = resolveIndexerNetwork(process.env);
  const db = new Pool({ connectionString: DATABASE_URL });
  try {
    // The token registry and quote sides follow QWAKK_NETWORK; never rebuild another network's data with them.
    const stored = (await db.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = 'chain_id'")).rows[0]?.value ?? null;
    const check = databaseNetworkCheck({ configured: network.chainId, stored, assumed: args.assumed });
    if (!check.ok) throw new Error(check.reason);
    let poolIds = args.pools;
    if (args.stale) {
      const value = (await db.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = $1", [STALE_POOLS_KEY])).rows[0]?.value ?? "";
      poolIds = value.split(",").filter((id) => /^\d+$/.test(id));
    }
    if (args.all) {
      poolIds = (await db.query<{ id: string }>("SELECT DISTINCT pool_id::text AS id FROM swaps ORDER BY 1")).rows.map((row) => row.id);
    }
    if (!poolIds.length) {
      console.log("No pools to rebuild.");
      return;
    }
    for (const poolId of poolIds) console.log(JSON.stringify(await rebuildPool(db, poolId, args.apply)));
    if (!args.apply) console.log("Dry run only. Stop the indexer and add --apply to write.");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Candle rebuild failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
