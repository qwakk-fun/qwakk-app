import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { catchUpRange, catchUpWithSearch, ensurePoolStored, indexBlockRange, isNotFoundAnswer, resumeAfterPruning, verifyEventSearch, type ChainLookup } from "./block-sync";
import { eventValues, isQorAddress, LIQUIDITY_EVENT_TYPES, parseLiquidityEvent, parseSwapEvent, transactionSender, type ChainEvent } from "./amm-events";
import {
  CANDLE_INTERVALS, CANDLE_ROLLUPS, CHART_WINDOWS, bucketStart, candleInQuote, chooseQuoteSide, knownDecimals, pairFigures, priceInQuote, swapTrade,
  toDisplayUnits, type QuoteSide,
} from "./market-math";
import { minTvlFor, quoteRank, resolveTokenInfo, type DenomMetadata } from "./token-registry";
import { chainGuard, evaluateIndexerHealth, freshStartHeight, healthConfig, lpSnapshotRule, resolveIndexerNetwork, retentionConfig, type SyncState } from "./indexer-config";
import { positionBalances } from "./positions";
import { describePointsConfig, loadPointsConfig } from "./points-config";
import { formatPoints, scoreSeason, type ScoringInput } from "./points-scoring";

const configWarnings: string[] = [];
const { network: NETWORK, warnings: networkWarnings } = resolveIndexerNetwork(process.env);
configWarnings.push(...networkWarnings);
/** Defaults follow QWAKK_NETWORK; QORECHAIN_REST_URL and QORECHAIN_RPC_URL still override them. */
const REST_URL = NETWORK.restUrl;
const RPC_URL = NETWORK.rpcUrl;
const HEALTH = healthConfig(process.env, configWarnings);
const RETENTION = retentionConfig(process.env, configWarnings);
const PORT = Number(process.env.QWAKK_INDEXER_PORT ?? 4400);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://qwakk:qwakk_local@localhost:5438/qwakk";
/** Optional first block for a fresh database. It must still be kept by the node. */
const START_HEIGHT = Number(process.env.QWAKK_INDEXER_START_HEIGHT ?? 0);
const db = new Pool({ connectionString: DATABASE_URL });

const { config: pointsConfig, warnings: pointsWarnings } = loadPointsConfig();
const pointsConfigJson = describePointsConfig(pointsConfig);
const pointsConfigHash = createHash("sha256").update(JSON.stringify(pointsConfigJson)).digest("hex").slice(0, 16);
/** LP snapshots are checked every minute and written once per UTC hour per position. */
const SNAPSHOT_CHECK_MS = 60_000;
const SNAPSHOT_CONCURRENCY = 6;
/** The whole season is rescored from raw data on this cadence. */
const SCORING_INTERVAL_MS = 5 * 60_000;

type ChainPool = {
  id?: string | number;
  pool_id?: string | number;
  pool_type?: string;
  type?: string;
  creator?: string;
  token_a?: string;
  token_b?: string;
  reserve_a?: string;
  reserve_b?: string;
  lp_supply?: string;
  lp_denom?: string;
  /** Block height at creation, not a timestamp. */
  created_at?: string | number;
  status?: string;
  weighted_avg_price?: string;
  amplification_coefficient?: number;
};

function asText(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function normalizePool(value: ChainPool) {
  return {
    id: asText(value.id ?? value.pool_id),
    poolType: asText(value.pool_type ?? value.type) || "constant_product",
    creator: asText(value.creator),
    tokenA: asText(value.token_a),
    tokenB: asText(value.token_b),
    reserveA: asText(value.reserve_a) || "0",
    reserveB: asText(value.reserve_b) || "0",
    lpSupply: asText(value.lp_supply) || "0",
    lpDenom: asText(value.lp_denom),
    createdHeight: /^\d+$/.test(asText(value.created_at)) ? asText(value.created_at) : "",
    status: asText(value.status) || "active",
    weightedAvgPrice: asText(value.weighted_avg_price),
    amplificationCoefficient: Number(value.amplification_coefficient ?? 0),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  return (await fetchWithHeight<T>(url)).data;
}

/** Reads a QoreChain endpoint and the block height the gateway answered at, when it says. */
async function fetchWithHeight<T>(url: string): Promise<{ data: T; height: number | null }> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`QoreChain request failed with ${response.status}`);
  const header = response.headers.get("grpc-metadata-x-cosmos-block-height") ?? response.headers.get("x-cosmos-block-height");
  const height = header && /^\d+$/.test(header) ? Number(header) : null;
  return { data: await response.json() as T, height: height && Number.isSafeInteger(height) ? height : null };
}

/**
 * Reads a QoreChain endpoint where "does not exist" is a valid answer. Only a
 * positive not-found returns missing; every other failure throws, so the
 * block being indexed is retried instead of skipped.
 */
async function fetchChainLookup<T>(url: string): Promise<ChainLookup<T>> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.ok) return { status: "found", value: await response.json() as T };
  const body: unknown = await response.json().catch(() => null);
  if (isNotFoundAnswer(response.status, body)) return { status: "missing" };
  throw new Error(`QoreChain request failed with ${response.status}`);
}

/** indexer_state key listing pool ids whose candles need an opt-in rebuild. */
const STALE_POOLS_KEY = "stale_candle_pools";

/** Token rows are re-read from the chain this often, so corrected metadata reaches stored rows. */
const TOKEN_REFRESH_MS = 60 * 60_000;
const tokenCheckedAt = new Map<string, number>();

type TokenRow = { symbol: string; name: string | null; decimals: number | null; image_url: string | null };

/**
 * Stores or refreshes one token: curated facts first, then chain metadata.
 * A new token whose metadata read fails throws, so wrong decimals are never
 * stored for good; an existing row is kept as it is and retried later.
 */
/**
 * Records pools whose stored swap prices and candles were computed with
 * decimals that no longer match the token row. Nothing is rewritten here:
 * the owner may run indexer/rebuild-candles.ts for these pools.
 */
async function markPoolsStale(denom: string, before: number | null, after: number | null) {
  const affected = await db.query<{ id: string }>(
    "SELECT p.id::text AS id FROM pools p WHERE (p.token_a = $1 OR p.token_b = $1) AND EXISTS (SELECT 1 FROM swaps s WHERE s.pool_id = p.id)",
    [denom],
  );
  console.warn(`Token ${denom} decimals changed from ${before ?? "unknown"} to ${after ?? "unknown"}.`);
  if (!affected.rowCount) return;
  const stored = (await getState(STALE_POOLS_KEY) ?? "").split(",").filter((id) => /^\d+$/.test(id));
  const pools = [...new Set([...stored, ...affected.rows.map((row) => row.id)])].sort((a, b) => Number(a) - Number(b));
  await setState(STALE_POOLS_KEY, pools.join(","));
  console.warn(`Swap prices and candles of pools ${affected.rows.map((row) => row.id).join(", ")} used the old decimals. Run indexer/rebuild-candles.ts --stale to rebuild them (see the file header).`);
}

async function upsertToken(denom: string) {
  if (!denom) return;
  const checked = tokenCheckedAt.get(denom);
  if (checked !== undefined && Date.now() - checked < TOKEN_REFRESH_MS) return;
  const existing = (await db.query<TokenRow>("SELECT symbol, name, decimals, image_url FROM tokens WHERE denom = $1", [denom])).rows[0];

  let lookup: ChainLookup<{ metadata?: DenomMetadata }>;
  try {
    lookup = await fetchChainLookup<{ metadata?: DenomMetadata }>(`${REST_URL}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`);
  } catch (error) {
    if (!existing) throw error;
    // Retry in a minute rather than on every 5 second pool refresh.
    tokenCheckedAt.set(denom, Date.now() - TOKEN_REFRESH_MS + 60_000);
    console.error(`Token metadata refresh failed for ${denom}, keeping the stored row`);
    return;
  }
  const metadata = lookup.status === "found" ? lookup.value.metadata : undefined;
  const info = resolveTokenInfo(denom, metadata);
  const storedDecimals = existing ? knownDecimals(existing.decimals) : null;
  const decimalsChanged = Boolean(existing) && storedDecimals !== info.decimals;
  const changed = !existing || decimalsChanged || existing.symbol !== info.symbol || existing.name !== info.name || existing.image_url !== info.imageUrl;
  if (changed) {
    await db.query(
      `INSERT INTO tokens (denom, symbol, name, decimals, image_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (denom) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals, image_url = EXCLUDED.image_url, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [denom, info.symbol, info.name, info.decimals, info.imageUrl, metadata ?? {}],
    );
    if (decimalsChanged) await markPoolsStale(denom, storedDecimals, info.decimals);
  }
  if (info.decimals === null && (!existing || decimalsChanged)) console.warn(`Token ${denom} has no known decimals (${info.source}); its pools stay unpriced until it is curated or its metadata lists a display unit`);
  tokenCheckedAt.set(denom, Date.now());
}

function poolQuoteSide(tokenA: string, tokenB: string): QuoteSide {
  return chooseQuoteSide(quoteRank(tokenA), quoteRank(tokenB));
}

async function persistPool(pool: ReturnType<typeof normalizePool>) {
  if (!/^\d+$/.test(pool.id) || !pool.tokenA || !pool.tokenB) return;
  await Promise.all([upsertToken(pool.tokenA), upsertToken(pool.tokenB)]);
  await db.query(
    `INSERT INTO pools (id, pool_type, creator, token_a, token_b, lp_denom, status, created_height, amplification_coefficient)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::bigint, $9)
     ON CONFLICT (id) DO UPDATE SET pool_type = EXCLUDED.pool_type, creator = EXCLUDED.creator, token_a = EXCLUDED.token_a, token_b = EXCLUDED.token_b, lp_denom = EXCLUDED.lp_denom, status = EXCLUDED.status, created_height = EXCLUDED.created_height, amplification_coefficient = EXCLUDED.amplification_coefficient, updated_at = NOW()`,
    [pool.id, pool.poolType, pool.creator || null, pool.tokenA, pool.tokenB, pool.lpDenom || null, pool.status, pool.createdHeight, pool.amplificationCoefficient],
  );
  // Pools are polled every few seconds; only a changed state earns a new snapshot row.
  await db.query(
    `INSERT INTO pool_snapshots (pool_id, reserve_a, reserve_b, lp_supply, weighted_avg_price)
     SELECT $1, $2::numeric, $3::numeric, $4::numeric, NULLIF($5, '')::numeric
     WHERE NOT EXISTS (
       SELECT 1 FROM (
         SELECT reserve_a, reserve_b, lp_supply, weighted_avg_price FROM pool_snapshots
         WHERE pool_id = $1 ORDER BY observed_at DESC LIMIT 1
       ) latest
       WHERE latest.reserve_a = $2::numeric AND latest.reserve_b = $3::numeric AND latest.lp_supply = $4::numeric
         AND latest.weighted_avg_price IS NOT DISTINCT FROM NULLIF($5, '')::numeric
     )`,
    [pool.id, pool.reserveA, pool.reserveB, pool.lpSupply, pool.weightedAvgPrice],
  );
}

const POOL_PAGE_LIMIT = 200;
const POOL_MAX_PAGES = 100;

/**
 * Every pool on the chain. QueryPoolsRequest in @qorechain/sdk 0.8.2 has no
 * pagination field and the answer has no pagination block, so today one read
 * returns all pools. The standard Cosmos pagination parameters are sent anyway
 * and next_key is followed if a later chain version starts paging.
 */
async function readAllPools() {
  const pools = new Map<string, ReturnType<typeof normalizePool>>();
  let key = "";
  for (let page = 0; page < POOL_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ "pagination.limit": String(POOL_PAGE_LIMIT) });
    if (key) params.set("pagination.key", key);
    const result = await fetchJson<{ pools?: ChainPool[]; pagination?: { next_key?: string | null } }>(`${REST_URL}/qorechain/amm/v1/pools?${params}`);
    for (const pool of Array.isArray(result.pools) ? result.pools.map(normalizePool) : []) {
      if (pool.id) pools.set(pool.id, pool);
    }
    const next = result.pagination?.next_key ?? "";
    if (!next || next === key) return [...pools.values()];
    key = next;
  }
  console.warn(`Pool list still had more pages after ${POOL_MAX_PAGES}; indexing the first ${pools.size} pools`);
  return [...pools.values()];
}

async function refreshPools() {
  const pools = await readAllPools();
  for (const pool of pools) await persistPool(pool);
  return pools.length;
}

/**
 * Makes sure a pool referenced by an event is stored. The pool list is read
 * before the block range, so a pool created inside the range is fetched here
 * instead of its first swaps being dropped. Returns false only when the chain
 * says the pool does not exist; fetch and database errors propagate.
 */
function ensurePool(poolId: string) {
  return ensurePoolStored(poolId, {
    isStored: async (id) => Boolean((await db.query("SELECT 1 FROM pools WHERE id = $1", [id])).rowCount),
    fetchPool: async (id) => {
      const lookup = await fetchChainLookup<{ pool?: ChainPool }>(`${REST_URL}/qorechain/amm/v1/pools/${id}`);
      if (lookup.status === "missing") return lookup;
      if (!lookup.value.pool) throw new Error(`QoreChain answered pool ${id} without a pool`);
      return { status: "found", value: normalizePool(lookup.value.pool) };
    },
    persist: persistPool,
  });
}

/** Latest block and earliest block the RPC node still keeps (it prunes older ones). */
async function chainStatus() {
  const status = await fetchJson<{ result?: { node_info?: { network?: string }; sync_info?: { latest_block_height?: string; earliest_block_height?: string } } }>(`${RPC_URL}/status`);
  const latest = Number(status.result?.sync_info?.latest_block_height ?? 0);
  if (!Number.isSafeInteger(latest) || latest <= 0) throw new Error("QoreChain did not return a valid block height");
  const earliest = Number(status.result?.sync_info?.earliest_block_height ?? 0);
  syncState.chainHeight = latest;
  return { latest, earliest: Number.isSafeInteger(earliest) && earliest > 0 ? earliest : 0, network: status.result?.node_info?.network ?? "" };
}

type ChainStatus = Awaited<ReturnType<typeof chainStatus>>;

/** Chain id the REST gateway serves. */
async function restChainId() {
  const info = await fetchJson<{ default_node_info?: { network?: string } }>(`${REST_URL}/cosmos/base/tendermint/v1beta1/node_info`);
  return info.default_node_info?.network ?? "";
}

/** In-memory sync state for /health. */
const syncState: SyncState = { chainId: null, height: null, chainHeight: null, lastSyncAt: null, lastErrorAt: null, startedAt: new Date() };

async function saveIndexedHeight(height: number) {
  await setState("last_indexed_height", String(height));
  syncState.height = height;
  // Saving a block is sync progress, so a long catch-up tick does not read as stalled.
  syncState.lastSyncAt = new Date();
}

async function latestHeight() {
  return (await chainStatus()).latest;
}

async function getState(key: string) {
  const result = await db.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = $1", [key]);
  return result.rows[0]?.value;
}

async function setState(key: string, value: string) {
  await db.query(
    `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

async function recordCandle(poolId: string, executedAt: Date, price: string, volumeQor: string | null, volumeQuote: string | null) {
  for (const [interval, seconds] of Object.entries(CANDLE_INTERVALS)) {
    // Rows written before volume_quote existed only carry volume_qor, which is the quote volume whenever it is set.
    await db.query(
      `INSERT INTO candles (pool_id, interval, start_time, open, high, low, close, volume_qor, volume_quote, transactions)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, $6, 1)
       ON CONFLICT (pool_id, interval, start_time) DO UPDATE SET
         high = GREATEST(candles.high, EXCLUDED.high),
         low = LEAST(candles.low, EXCLUDED.low),
         close = EXCLUDED.close,
         volume_qor = CASE WHEN candles.volume_qor IS NULL AND EXCLUDED.volume_qor IS NULL THEN NULL ELSE COALESCE(candles.volume_qor, 0) + COALESCE(EXCLUDED.volume_qor, 0) END,
         volume_quote = CASE WHEN COALESCE(candles.volume_quote, candles.volume_qor) IS NULL AND EXCLUDED.volume_quote IS NULL THEN NULL
           ELSE COALESCE(candles.volume_quote, candles.volume_qor, 0) + COALESCE(EXCLUDED.volume_quote, 0) END,
         transactions = candles.transactions + 1`,
      [poolId, interval, bucketStart(executedAt, seconds), price, volumeQor, volumeQuote],
    );
  }
}

/**
 * Fills target candles (CANDLE_ROLLUPS, today 4h from 1h) for history that
 * was indexed before the target interval existed. Runs on every start before
 * the sync loop, so no swap is being recorded meanwhile. Buckets that already
 * have a target row are left alone (ON CONFLICT DO NOTHING): those were written
 * live by recordCandle or by an earlier run. It only inserts rows and never
 * changes or deletes any. Twin of rollUpCandles in market-math.ts.
 */
async function backfillRolledUpCandles() {
  for (const { target, source } of CANDLE_ROLLUPS) {
    const seconds = CANDLE_INTERVALS[target];
    const sourceSeconds = CANDLE_INTERVALS[source];
    if (!seconds || !sourceSeconds || seconds % sourceSeconds !== 0) throw new Error(`Cannot roll ${source} candles up into ${target}`);
    const result = await db.query(
      `INSERT INTO candles (pool_id, interval, start_time, open, high, low, close, volume_qor, volume_quote, transactions)
       SELECT pool_id, $1::text, bucket,
              (ARRAY_AGG(open ORDER BY start_time ASC))[1],
              MAX(high),
              MIN(low),
              (ARRAY_AGG(close ORDER BY start_time DESC))[1],
              SUM(volume_qor),
              SUM(COALESCE(volume_quote, volume_qor)),
              SUM(transactions)
         FROM (SELECT c.*, TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM c.start_time) / $2::int) * $2::int) AS bucket
                 FROM candles c WHERE c.interval = $3) source
        GROUP BY pool_id, bucket
       ON CONFLICT (pool_id, interval, start_time) DO NOTHING`,
      [target, seconds, source],
    );
    if (result.rowCount) console.log(`Backfilled ${result.rowCount} ${target} candles from ${source} candles`);
  }
}

async function recordSwap(event: ChainEvent, executedAt: Date, height: number, txHash: string, eventIndex: number, txSender: string | null) {
  const values = eventValues(event);
  const swap = parseSwapEvent(values, txSender);
  if (!swap || !await ensurePool(swap.poolId)) return;

  const poolResult = await db.query<{ token_a: string; token_b: string }>("SELECT token_a, token_b FROM pools WHERE id = $1", [swap.poolId]);
  const pool = poolResult.rows[0];
  if (!pool) return;
  const tokenResult = await db.query<{ denom: string; decimals: number | null }>("SELECT denom, decimals FROM tokens WHERE denom = ANY($1)", [[pool.token_a, pool.token_b, "uqor"]]);
  const decimals = new Map(tokenResult.rows.map((token) => [token.denom, knownDecimals(token.decimals)]));
  const decimalsA = decimals.get(pool.token_a) ?? null;
  const decimalsB = decimals.get(pool.token_b) ?? null;
  // A swap on a pool with a token of unknown decimals is stored unpriced and writes no candle.
  // When the decimals become known the pool is marked stale (see upsertToken) for an opt-in rebuild.
  const { price, volumeQor, volumeQuote } = decimalsA === null || decimalsB === null
    ? { price: null, volumeQor: null, volumeQuote: null }
    : swapTrade(swap, {
      tokenA: pool.token_a,
      tokenB: pool.token_b,
      decimalsA,
      decimalsB,
      qorDecimals: decimals.get("uqor") ?? 6,
      quoteSide: poolQuoteSide(pool.token_a, pool.token_b),
    });
  const inserted = await db.query(
    `INSERT INTO swaps (tx_hash, event_index, pool_id, height, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tx_hash, event_index) DO NOTHING`,
    [txHash, eventIndex, swap.poolId, height, executedAt, swap.sender, swap.denomIn, swap.amountIn, swap.denomOut, swap.amountOut, price, values],
  );
  if (inserted.rowCount && price !== null) await recordCandle(swap.poolId, executedAt, price, volumeQor, volumeQuote);
}

async function recordLiquidityEvent(event: ChainEvent, executedAt: Date, height: number, txHash: string, eventIndex: number, txSender: string | null) {
  const values = eventValues(event);
  const parsed = parseLiquidityEvent(event.type, values, txSender);
  if (!parsed) return;
  // A pool created inside the current block range is not in the pool list yet.
  if (parsed.poolId) await ensurePool(parsed.poolId);
  await db.query(
    `INSERT INTO liquidity_events (tx_hash, event_index, event_type, pool_id, height, executed_at, sender, coins, qor_amount, lp_amount, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tx_hash, event_index) DO NOTHING`,
    [txHash, eventIndex, parsed.eventType, parsed.poolId, height, executedAt, parsed.sender, parsed.coins, parsed.qorAmount, parsed.lpAmount, values],
  );
}

async function processBlock(height: number) {
  const [blockData, resultsData] = await Promise.all([
    fetchJson<{ result?: { block?: { header?: { time?: string }; data?: { txs?: string[] } } } }>(`${RPC_URL}/block?height=${height}`),
    fetchJson<{ result?: { txs_results?: Array<{ code?: number; events?: ChainEvent[] }> } }>(`${RPC_URL}/block_results?height=${height}`),
  ]);
  const timestamp = new Date(blockData.result?.block?.header?.time ?? Date.now());
  const txs = blockData.result?.block?.data?.txs ?? [];
  const results = resultsData.result?.txs_results ?? [];
  for (const [index, result] of results.entries()) {
    // A failed transaction changed no AMM state, whatever events it reports.
    if (Number(result.code ?? 0) !== 0) continue;
    const tx = txs[index] ?? `${height}:${index}`;
    const txHash = tx.includes(":") ? tx : createHash("sha256").update(Buffer.from(tx, "base64")).digest("hex").toUpperCase();
    const events = result.events ?? [];
    if (!events.some((event) => event.type?.startsWith("amm_"))) continue;
    const txSender = transactionSender(events);
    for (const [eventIndex, event] of events.entries()) {
      if (event.type === "amm_swap") await recordSwap(event, timestamp, height, txHash, eventIndex, txSender);
      else if (event.type === "amm_pool_created" || event.type === "amm_liquidity_added" || event.type === "amm_liquidity_removed") {
        await recordLiquidityEvent(event, timestamp, height, txHash, eventIndex, txSender);
      }
    }
  }
}

/** AMM event types the indexer stores; each carries a pool_id attribute. */
const AMM_EVENT_TYPES = ["amm_swap", ...Object.keys(LIQUIDITY_EVENT_TYPES)];
const TX_SEARCH_PAGE = 100;

/**
 * Heights in [from, to] holding AMM events, from the CometBFT tx_search RPC.
 * It only chooses which blocks to read; every block still goes through
 * processBlock. Throws when the node cannot search, so the caller scans instead.
 */
async function findAmmHeights(from: number, to: number) {
  const heights = new Set<number>();
  for (const type of AMM_EVENT_TYPES) {
    const query = `${type}.pool_id EXISTS AND tx.height >= ${from} AND tx.height <= ${to}`;
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({ query: `"${query}"`, page: String(page), per_page: String(TX_SEARCH_PAGE), order_by: `"asc"` });
      const answer = await fetchJson<{ result?: { total_count?: string; txs?: Array<{ height?: string }> }; error?: unknown }>(`${RPC_URL}/tx_search?${params}`);
      if (!answer.result) throw new Error("QoreChain tx search is unavailable");
      const txs = answer.result.txs ?? [];
      for (const tx of txs) {
        const height = Number(tx.height);
        if (Number.isSafeInteger(height)) heights.add(height);
      }
      const total = Number(answer.result.total_count ?? 0);
      if (!txs.length || page * TX_SEARCH_PAGE >= total) break;
    }
  }
  return [...heights];
}

/**
 * The newest block still kept by the node that we know holds an AMM event:
 * a stored swap or liquidity event, or a pool's creation height (pools are
 * read from the chain before blocks, so a fresh database has them too).
 */
async function referenceAmmHeight(earliest: number) {
  const result = await db.query<{ height: string | null }>(
    `SELECT MAX(height)::text AS height FROM (
       SELECT height FROM swaps UNION ALL SELECT height FROM liquidity_events
       UNION ALL SELECT created_height AS height FROM pools WHERE created_height IS NOT NULL
     ) known WHERE height >= $1`,
    [earliest],
  );
  const height = Number(result.rows[0]?.height ?? 0);
  return Number.isSafeInteger(height) && height > 0 ? height : null;
}

let searchWarning = "";
function warnOnce(message: string) {
  if (searchWarning === message) return;
  searchWarning = message;
  console.error(message);
}

/** Event search spans run per sync tick while far behind the tip. */
const CATCH_UP_SPANS_PER_TICK = 10;

async function syncBlocks(status: ChainStatus) {
  const { latest: currentHeight, earliest } = status;
  let savedHeight = Number(await getState("last_indexed_height") ?? 0);
  if (!savedHeight) {
    const firstPool = await db.query<{ height: string | null }>("SELECT MIN(created_height)::text AS height FROM pools");
    const start = freshStartHeight({ configured: START_HEIGHT, currentHeight, earliestHeight: earliest, firstPoolHeight: firstPool.rows[0]?.height ? Number(firstPool.rows[0].height) : null });
    console.log(`Fresh database: indexing starts after block ${start}`);
    await saveIndexedHeight(start);
    return;
  }
  const resumed = resumeAfterPruning(savedHeight, earliest);
  if (resumed.skipped) {
    console.warn(`Blocks ${resumed.skipped.from} to ${resumed.skipped.to} are pruned by the QoreChain node and cannot be indexed; resuming at ${earliest}`);
    await setState("pruned_gap", `${resumed.skipped.from}-${resumed.skipped.to}`);
    await saveIndexedHeight(resumed.savedHeight);
    savedHeight = resumed.savedHeight;
  }
  const handlers = { processBlock, saveHeight: saveIndexedHeight };
  let searchUsable = false;
  if (catchUpRange(savedHeight, currentHeight)) {
    const reference = await referenceAmmHeight(earliest);
    try {
      searchUsable = await verifyEventSearch(reference, findAmmHeights);
      if (!searchUsable) {
        warnOnce(reference === null
          ? "No known AMM event to verify the node's tx index against; catching up by scanning every block"
          : `QoreChain tx_search did not find the known AMM event at height ${reference}; its tx index cannot be trusted, catching up by scanning every block`);
      }
    } catch (error) {
      warnOnce(`QoreChain tx_search is unavailable (${error instanceof Error ? error.message : "unknown error"}); catching up by scanning every block`);
    }
  }
  for (let spans = 0; searchUsable && spans < CATCH_UP_SPANS_PER_TICK; spans += 1) {
    const range = catchUpRange(savedHeight, currentHeight);
    if (!range) break;
    try {
      const found = await catchUpWithSearch(range.from, range.to, { ...handlers, findHeights: findAmmHeights });
      console.log(`Caught up blocks ${range.from} to ${range.to} (${found} with AMM events)`);
      savedHeight = range.to;
    } catch (error) {
      // processBlock failures and search failures both land here; block scanning below retries from the saved height.
      console.error("Catch-up by event search failed, scanning blocks instead", error instanceof Error ? error.message : error);
      savedHeight = Number(await getState("last_indexed_height") ?? savedHeight);
      break;
    }
  }
  // A failing block throws before its height is saved, so the next tick retries it.
  await indexBlockRange(savedHeight, Math.min(currentHeight, savedHeight + 30), handlers);
}

async function sync() {
  try {
    const status = await chainStatus();
    // The chain id was verified at start; a node swapped behind the same URL must not get written in.
    if (status.network !== NETWORK.chainId) throw new Error(`QoreChain RPC now serves ${status.network || "an unknown chain"}, expected ${NETWORK.chainId}; nothing written`);
    await refreshPools();
    await syncBlocks(status);
    syncState.lastSyncAt = new Date();
  } catch (error) {
    syncState.lastErrorAt = new Date();
    throw error;
  }
}

/** Runs a job unless its previous run is still going, and never lets a failure escape. */
function singleFlight(name: string, job: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (error) {
      console.error(`${name} failed`, error);
    } finally {
      running = false;
    }
  };
}

const runSync = singleFlight("Indexer sync", sync);

async function mapLimit<T>(items: T[], limit: number, job: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await job(item);
    }
  }));
}

/**
 * Positions to snapshot this hour: every (pool, address) that created a pool
 * or added liquidity, except positions already closed (last snapshot was 0 and
 * no liquidity event since) and positions already written for this hour.
 * LP shares cannot be transferred, so no other address can hold them.
 */
const TRACKED_POSITIONS_SQL = `
  WITH holders AS (
    SELECT DISTINCT pool_id, sender AS address FROM liquidity_events
    WHERE pool_id IS NOT NULL AND sender IS NOT NULL AND event_type IN ('pool_created', 'liquidity_added')
    UNION
    SELECT id AS pool_id, creator AS address FROM pools WHERE creator IS NOT NULL
  )
  SELECT h.pool_id::text AS pool_id, h.address
  FROM holders h
  LEFT JOIN LATERAL (
    SELECT lp_balance, height FROM lp_snapshots s
    WHERE s.pool_id = h.pool_id AND s.address = h.address ORDER BY snapshot_hour DESC LIMIT 1
  ) last ON true
  WHERE (
    last.lp_balance IS NULL OR last.lp_balance > 0 OR EXISTS (
      SELECT 1 FROM liquidity_events e WHERE e.pool_id = h.pool_id AND e.sender = h.address AND e.height > last.height
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM lp_snapshots s WHERE s.pool_id = h.pool_id AND s.address = h.address AND s.snapshot_hour = $1
  )
  ORDER BY h.pool_id, h.address`;

async function snapshotLiquidity() {
  const hour = bucketStart(new Date(), 3600);
  const tracked = await db.query<{ pool_id: string; address: string }>(TRACKED_POSITIONS_SQL, [hour]);
  if (!tracked.rowCount) return;
  const statusHeight = await latestHeight();
  const byPool = new Map<string, string[]>();
  for (const row of tracked.rows) {
    if (!/^\d+$/.test(row.pool_id) || !isQorAddress(row.address)) continue;
    byPool.set(row.pool_id, [...(byPool.get(row.pool_id) ?? []), row.address]);
  }
  let failures = 0;
  for (const [poolId, addresses] of byPool) {
    let pool: ReturnType<typeof normalizePool>;
    try {
      const result = await fetchJson<{ pool?: ChainPool }>(`${REST_URL}/qorechain/amm/v1/pools/${poolId}`);
      if (!result.pool) throw new Error("Pool missing");
      pool = normalizePool(result.pool);
    } catch {
      failures += addresses.length;
      continue;
    }
    await mapLimit(addresses, SNAPSHOT_CONCURRENCY, async (address) => {
      try {
        const { data, height } = await fetchWithHeight<{ balance?: string }>(`${REST_URL}/qorechain/amm/v1/pools/${poolId}/lp/${encodeURIComponent(address)}`);
        const balance = /^\d+$/.test(data.balance ?? "") ? data.balance as string : "0";
        await db.query(
          `INSERT INTO lp_snapshots (pool_id, address, snapshot_hour, height, lp_balance, lp_supply, reserve_a, reserve_b)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (pool_id, address, snapshot_hour) DO NOTHING`,
          [poolId, address, hour, height ?? statusHeight, balance, pool.lpSupply, pool.reserveA, pool.reserveB],
        );
      } catch {
        failures += 1;
      }
    });
  }
  // Missed positions are retried on the next check within the same hour.
  if (failures) console.error(`LP snapshot missed ${failures} positions this run`);
}

const runSnapshots = singleFlight("LP snapshot", snapshotLiquidity);

async function loadScoringInput(): Promise<ScoringInput> {
  const throughHeight = Number(await getState("last_indexed_height") ?? 0);
  const startHeight = pointsConfig.seasonStartHeight;
  const [pools, swaps, liquidity, snapshots] = await Promise.all([
    db.query<{ id: string; token_a: string; token_b: string; creator: string | null; created_height: string | null }>(
      "SELECT id::text, token_a, token_b, creator, created_height::text FROM pools",
    ),
    db.query<{ pool_id: string; height: string; executed_at: Date; tx_hash: string; event_index: number; sender: string | null; denom_in: string; amount_in: string; denom_out: string; amount_out: string }>(
      `SELECT pool_id::text, height::text, executed_at, tx_hash, event_index, sender, denom_in, amount_in::text, denom_out, amount_out::text
       FROM swaps WHERE height >= $1 AND height <= $2`,
      [startHeight, throughHeight],
    ),
    // Liquidity events before the season still matter for removals inside the first snapshot interval.
    db.query<{ pool_id: string | null; height: string; executed_at: Date; tx_hash: string; event_index: number; event_type: string; sender: string | null; qor_amount: string | null; lp_amount: string | null }>(
      `SELECT pool_id::text, height::text, executed_at, tx_hash, event_index, event_type, sender, qor_amount::text, lp_amount::text
       FROM liquidity_events WHERE height <= $1`,
      [throughHeight],
    ),
    db.query<{ pool_id: string; address: string; snapshot_hour: Date; height: string; lp_balance: string; lp_supply: string; reserve_a: string; reserve_b: string }>(
      `SELECT pool_id::text, address, snapshot_hour, height::text, lp_balance::text, lp_supply::text, reserve_a::text, reserve_b::text
       FROM lp_snapshots WHERE height >= $1 AND height <= $2`,
      [startHeight, throughHeight],
    ),
  ]);
  return {
    throughHeight,
    pools: pools.rows.map((row) => ({ id: row.id, tokenA: row.token_a, tokenB: row.token_b, creator: row.creator, createdHeight: row.created_height === null ? null : Number(row.created_height) })),
    swaps: swaps.rows.map((row) => ({ poolId: row.pool_id, height: Number(row.height), executedAt: row.executed_at.toISOString(), txHash: row.tx_hash, eventIndex: row.event_index, sender: row.sender, denomIn: row.denom_in, amountIn: row.amount_in, denomOut: row.denom_out, amountOut: row.amount_out })),
    liquidityEvents: liquidity.rows
      .filter((row) => row.event_type === "pool_created" || row.event_type === "liquidity_added" || row.event_type === "liquidity_removed")
      .map((row) => ({ poolId: row.pool_id, height: Number(row.height), executedAt: row.executed_at.toISOString(), txHash: row.tx_hash, eventIndex: row.event_index, eventType: row.event_type as "pool_created" | "liquidity_added" | "liquidity_removed", sender: row.sender, qorAmount: row.qor_amount, lpAmount: row.lp_amount })),
    lpSnapshots: snapshots.rows.map((row) => ({ poolId: row.pool_id, address: row.address, snapshotHour: row.snapshot_hour.toISOString(), height: Number(row.height), lpBalance: row.lp_balance, lpSupply: row.lp_supply, reserveA: row.reserve_a, reserveB: row.reserve_b })),
  };
}

/** Rebuilds the derived points tables of the season in one transaction. Raw tables are only read. */
async function scorePoints() {
  const input = await loadScoringInput();
  if (!input.throughHeight) return;
  const result = scoreSeason(input, pointsConfig);
  const season = pointsConfig.season;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM points_scores WHERE season = $1", [season]);
    await client.query("DELETE FROM points_daily WHERE season = $1", [season]);
    await client.query("DELETE FROM points_pool_bonuses WHERE season = $1", [season]);
    const scores = result.addresses;
    if (scores.length) {
      await client.query(
        `INSERT INTO points_scores (season, address, rank, total_points, swap_points, liquidity_points, pool_points, activity_points, active_days,
           swap_volume_uqor, round_trip_volume_uqor, liquidity_uqor_hours, pools_created, pools_unlocked, first_height, last_height)
         SELECT $1, * FROM unnest($2::text[], $3::int[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::int[],
           $10::numeric[], $11::numeric[], $12::numeric[], $13::int[], $14::int[], $15::bigint[], $16::bigint[])`,
        [
          season,
          scores.map((row) => row.address),
          scores.map((row) => row.rank),
          scores.map((row) => formatPoints(row.totalMicro)),
          scores.map((row) => formatPoints(row.swapMicro)),
          scores.map((row) => formatPoints(row.liquidityMicro)),
          scores.map((row) => formatPoints(row.poolMicro)),
          scores.map((row) => formatPoints(row.activityMicro)),
          scores.map((row) => row.activeDays),
          scores.map((row) => row.swapVolumeUqor.toString()),
          scores.map((row) => row.roundTripVolumeUqor.toString()),
          scores.map((row) => row.liquidityUqorHours.toString()),
          scores.map((row) => row.poolsCreated),
          scores.map((row) => row.poolsUnlocked),
          scores.map((row) => String(row.firstHeight)),
          scores.map((row) => String(row.lastHeight)),
        ],
      );
    }
    if (result.daily.length) {
      await client.query(
        `INSERT INTO points_daily (season, address, day, swap_volume_uqor, round_trip_volume_uqor, swap_points, liquidity_points, active)
         SELECT $1, * FROM unnest($2::text[], $3::date[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::boolean[])`,
        [
          season,
          result.daily.map((row) => row.address),
          result.daily.map((row) => row.day),
          result.daily.map((row) => row.swapVolumeUqor.toString()),
          result.daily.map((row) => row.roundTripVolumeUqor.toString()),
          result.daily.map((row) => formatPoints(row.swapMicro)),
          result.daily.map((row) => formatPoints(row.liquidityMicro)),
          result.daily.map((row) => row.active),
        ],
      );
    }
    if (result.pools.length) {
      await client.query(
        `INSERT INTO points_pool_bonuses (season, pool_id, creator, created_height, distinct_traders, status, unlocked_height, points)
         SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::int[], $6::text[], $7::bigint[], $8::numeric[])`,
        [
          season,
          result.pools.map((row) => row.poolId),
          result.pools.map((row) => row.creator),
          result.pools.map((row) => String(row.createdHeight)),
          result.pools.map((row) => row.distinctTraders),
          result.pools.map((row) => row.status),
          result.pools.map((row) => (row.unlockedHeight === null ? null : String(row.unlockedHeight))),
          result.pools.map((row) => formatPoints(row.pointsMicro)),
        ],
      );
    }
    await client.query(
      `INSERT INTO points_runs (season, computed_at, through_height, config_hash, config, participants)
       VALUES ($1, NOW(), $2, $3, $4, $5)
       ON CONFLICT (season) DO UPDATE SET computed_at = EXCLUDED.computed_at, through_height = EXCLUDED.through_height,
         config_hash = EXCLUDED.config_hash, config = EXCLUDED.config, participants = EXCLUDED.participants`,
      [season, input.throughHeight, pointsConfigHash, pointsConfigJson, scores.length],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const runScoring = singleFlight("Points scoring", scorePoints);

const RETENTION_BATCH = 5_000;

/** Runs a batched statement (it must touch at most RETENTION_BATCH rows) until nothing is left. */
async function inBatches(sql: string, params: unknown[]) {
  let total = 0;
  for (;;) {
    const result = await db.query(sql, params);
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < RETENTION_BATCH) return total;
  }
}

/**
 * Prunes rolling and derived data (indexer/README.md, Retention). Raw swaps
 * and liquidity events are never deleted: only fine candles past their served
 * window, old swap raw_event payloads (emptied to {}) and old LP snapshots,
 * always keeping each position's latest snapshot.
 */
async function pruneRetention() {
  if (!RETENTION.enabled) return;
  const pruned: string[] = [];
  for (const [interval, days] of [["1m", RETENTION.candles1mDays], ["5m", RETENTION.candles5mDays]] as const) {
    if (!days) continue;
    const count = await inBatches(
      `DELETE FROM candles WHERE ctid IN (
         SELECT ctid FROM candles WHERE interval = $1 AND start_time < NOW() - make_interval(days => $2) LIMIT ${RETENTION_BATCH})`,
      [interval, days],
    );
    if (count) pruned.push(`${count} ${interval} candles older than ${days} days`);
  }
  if (RETENTION.swapRawEventDays) {
    const count = await inBatches(
      `UPDATE swaps SET raw_event = '{}'::jsonb WHERE id IN (
         SELECT id FROM swaps WHERE executed_at < NOW() - make_interval(days => $1) AND raw_event <> '{}'::jsonb LIMIT ${RETENTION_BATCH})`,
      [RETENTION.swapRawEventDays],
    );
    if (count) pruned.push(`raw events of ${count} swaps older than ${RETENTION.swapRawEventDays} days`);
  }
  // Scoring rebuilds the season from its start height even while points are not public, so a season always wins.
  const rule = lpSnapshotRule(pointsConfig.seasonStartHeight, RETENTION.lpSnapshotDays);
  const snapshotRule = rule === null ? null : rule.kind === "below_height"
    ? { condition: "s.height < $1", param: rule.height, label: `below season start height ${rule.height}` }
    : { condition: "s.snapshot_hour < NOW() - make_interval(days => $1)", param: rule.days, label: `older than ${rule.days} days` };
  if (snapshotRule) {
    const count = await inBatches(
      `DELETE FROM lp_snapshots WHERE id IN (
         SELECT s.id FROM lp_snapshots s
         WHERE ${snapshotRule.condition}
           AND s.snapshot_hour < (SELECT MAX(l.snapshot_hour) FROM lp_snapshots l WHERE l.pool_id = s.pool_id AND l.address = s.address)
         LIMIT ${RETENTION_BATCH})`,
      [snapshotRule.param],
    );
    if (count) pruned.push(`${count} LP snapshots ${snapshotRule.label}`);
  }
  console.log(pruned.length ? `Retention pruned ${pruned.join("; ")}` : "Retention: nothing to prune");
}

const runRetention = singleFlight("Retention", pruneRetention);

/** Open LP positions of one address from indexed events and hourly snapshots. */
async function addressPositions(address: string) {
  const [events, snapshots, indexed] = await Promise.all([
    db.query<{ pool_id: string; event_type: string; lp_amount: string | null; height: string }>(
      "SELECT pool_id::text, event_type, lp_amount::text, height::text FROM liquidity_events WHERE sender = $1 AND pool_id IS NOT NULL",
      [address],
    ),
    db.query<{ pool_id: string; height: string; lp_balance: string }>(
      "SELECT DISTINCT ON (pool_id) pool_id::text, height::text, lp_balance::text FROM lp_snapshots WHERE address = $1 ORDER BY pool_id, snapshot_hour DESC, height DESC",
      [address],
    ),
    getState("last_indexed_height"),
  ]);
  const balances = positionBalances(
    events.rows.map((row) => ({ poolId: row.pool_id, eventType: row.event_type, lpAmount: row.lp_amount, height: Number(row.height) })),
    snapshots.rows.map((row) => ({ poolId: row.pool_id, height: Number(row.height), lpBalance: row.lp_balance })),
  );
  const pools = balances.length ? await db.query<{ id: string; token_a: string; token_b: string; token_a_symbol: string; token_b_symbol: string; token_a_decimals: number | null; token_b_decimals: number | null; lp_denom: string | null; lp_supply: string | null; reserve_a: string | null; reserve_b: string | null }>(
    `SELECT p.id::text, p.token_a, p.token_b, p.lp_denom, a.symbol AS token_a_symbol, a.decimals AS token_a_decimals, b.symbol AS token_b_symbol, b.decimals AS token_b_decimals,
            snapshot.lp_supply::text, snapshot.reserve_a::text, snapshot.reserve_b::text
     FROM pools p
     JOIN tokens a ON a.denom = p.token_a
     JOIN tokens b ON b.denom = p.token_b
     LEFT JOIN LATERAL (SELECT lp_supply, reserve_a, reserve_b FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
     WHERE p.id = ANY($1::bigint[])`,
    [balances.map((balance) => balance.poolId)],
  ) : { rows: [] };
  const byId = new Map(pools.rows.map((row) => [row.id, row]));
  return {
    address,
    indexedHeight: indexed ?? null,
    positions: balances.flatMap((balance) => {
      const pool = byId.get(balance.poolId);
      if (!pool) return [];
      return [{
        poolId: balance.poolId,
        tokenA: pool.token_a,
        tokenB: pool.token_b,
        tokenASymbol: pool.token_a_symbol,
        tokenBSymbol: pool.token_b_symbol,
        tokenADecimals: knownDecimals(pool.token_a_decimals),
        tokenBDecimals: knownDecimals(pool.token_b_decimals),
        lpDenom: pool.lp_denom,
        lpBalance: balance.lpBalance,
        lpSupply: pool.lp_supply,
        reserveA: pool.reserve_a,
        reserveB: pool.reserve_b,
        source: balance.source,
        asOfHeight: String(balance.asOfHeight),
      }];
    }),
  };
}

function exact<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

type MarketRowBase = {
  pool_type: string;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: number | string | null;
  token_b_decimals: number | string | null;
  reserve_a: string | null;
  reserve_b: string | null;
  price_b_per_a: string | null;
  price_24h_ago: string | null;
  volume_quote_24h: string | null;
};

/**
 * Pair-agnostic market fields. The quote token is QOR, then fUSD, otherwise
 * token B; prices read as quote per base and volume and TVL are in quote
 * display units. The older B-per-A and QOR-only fields are kept, except that
 * B-per-A prices are withheld (null) while a token's decimals are unknown.
 */
function quoteView(row: MarketRowBase) {
  const quoteSide = poolQuoteSide(row.token_a, row.token_b);
  const decimalsA = knownDecimals(row.token_a_decimals);
  const decimalsB = knownDecimals(row.token_b_decimals);
  const quoteDenom = quoteSide === "a" ? row.token_a : row.token_b;
  const figures = pairFigures({
    poolType: row.pool_type,
    decimalsA,
    decimalsB,
    reserveA: row.reserve_a,
    reserveB: row.reserve_b,
    priceBPerA: row.price_b_per_a,
    price24hAgoBPerA: row.price_24h_ago,
    volumeQuote24h: row.volume_quote_24h,
    quoteSide,
    minTvl: minTvlFor(quoteDenom),
  });
  return {
    token_a_decimals: decimalsA,
    token_b_decimals: decimalsB,
    decimals_known: figures.decimalsKnown,
    price_b_per_a: figures.decimalsKnown ? row.price_b_per_a : null,
    price_24h_ago: figures.decimalsKnown ? row.price_24h_ago : null,
    quote_side: quoteSide,
    base_denom: quoteSide === "a" ? row.token_b : row.token_a,
    base_symbol: quoteSide === "a" ? row.token_b_symbol : row.token_a_symbol,
    base_decimals: quoteSide === "a" ? decimalsB : decimalsA,
    quote_denom: quoteDenom,
    quote_symbol: quoteSide === "a" ? row.token_a_symbol : row.token_b_symbol,
    quote_decimals: quoteSide === "a" ? decimalsA : decimalsB,
    price_quote: figures.priceQuote,
    price_quote_24h_ago: figures.priceQuote24hAgo,
    price_change_percent_24h: figures.priceChangePercent24h,
    spot_price_quote: figures.spotPriceQuote,
    spot_price_b_per_a: figures.spotPriceBPerA,
    volume_quote_24h: figures.volumeQuote24h,
    tvl_quote: figures.tvlQuote,
    low_liquidity: figures.liquidity.lowLiquidity,
    low_liquidity_reason: figures.liquidity.reason,
  };
}

/** Latest trade price, the price 24 hours ago and 24h volumes, shared by the list and the detail query. */
const MARKET_FIGURES_SQL = `
     LEFT JOIN LATERAL (SELECT COUNT(*)::int AS transactions_24h FROM swaps WHERE pool_id = p.id AND executed_at >= NOW() - INTERVAL '24 hours') metrics ON true
     LEFT JOIN LATERAL (
       SELECT SUM(volume_qor) AS volume_qor_24h, SUM(COALESCE(volume_quote, volume_qor)) AS volume_quote_24h
       FROM candles WHERE pool_id = p.id AND interval = '1m' AND start_time >= NOW() - INTERVAL '24 hours'
     ) volume ON true
     -- Every interval's newest bucket closes on the latest trade; 1h is kept longer than 1m (see retention).
     LEFT JOIN LATERAL (SELECT close FROM candles WHERE pool_id = p.id AND interval = '1h' ORDER BY start_time DESC LIMIT 1) latest_candle ON true
     -- 1m first. When retention removed the 1m rows, there was no trade from the 1m cutoff to 24 hours ago,
     -- so the last 1h bucket ending by then closes on the same trade.
     LEFT JOIN LATERAL (SELECT COALESCE(
       (SELECT close FROM candles WHERE pool_id = p.id AND interval = '1m' AND start_time <= NOW() - INTERVAL '24 hours' ORDER BY start_time DESC LIMIT 1),
       (SELECT close FROM candles WHERE pool_id = p.id AND interval = '1h' AND start_time <= NOW() - INTERVAL '25 hours' ORDER BY start_time DESC LIMIT 1)
     ) AS close) earlier_candle ON true`;

async function marketList() {
  const result = await db.query<MarketRowBase & Record<string, unknown>>(
    `SELECT p.id, p.pool_type, p.status, p.token_a, p.token_b, p.created_height,
            a.symbol AS token_a_symbol, a.decimals AS token_a_decimals, a.image_url AS token_a_image,
            b.symbol AS token_b_symbol, b.decimals AS token_b_decimals, b.image_url AS token_b_image,
            snapshot.reserve_a, snapshot.reserve_b, snapshot.weighted_avg_price, snapshot.observed_at,
            COALESCE(metrics.transactions_24h, 0) AS transactions_24h,
            volume.volume_qor_24h,
            volume.volume_quote_24h,
            latest_candle.close AS price_b_per_a,
            earlier_candle.close AS price_24h_ago
     FROM pools p
     JOIN tokens a ON a.denom = p.token_a
     JOIN tokens b ON b.denom = p.token_b
     LEFT JOIN LATERAL (SELECT * FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
     ${MARKET_FIGURES_SQL}
     ORDER BY snapshot.observed_at DESC NULLS LAST, p.id DESC`,
  );
  return result.rows.map((row) => ({ ...row, ...quoteView(row) }));
}

type CandleRow = { start_time: Date; open: string; high: string; low: string; close: string; volume_qor: string | null; volume_quote: string | null; transactions: number };

async function poolDetail(poolId: string, interval: string) {
  const pool = await db.query<MarketRowBase & Record<string, unknown>>(
    `SELECT p.*, a.symbol AS token_a_symbol, a.name AS token_a_name, a.decimals AS token_a_decimals, a.image_url AS token_a_image,
            b.symbol AS token_b_symbol, b.name AS token_b_name, b.decimals AS token_b_decimals, b.image_url AS token_b_image,
            snapshot.reserve_a, snapshot.reserve_b, snapshot.lp_supply, snapshot.weighted_avg_price, snapshot.observed_at,
            COALESCE(metrics.transactions_24h, 0) AS transactions_24h,
            volume.volume_qor_24h,
            volume.volume_quote_24h,
            latest_candle.close AS price_b_per_a,
            earlier_candle.close AS price_24h_ago
     FROM pools p
     JOIN tokens a ON a.denom = p.token_a
     JOIN tokens b ON b.denom = p.token_b
     LEFT JOIN LATERAL (SELECT * FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
     ${MARKET_FIGURES_SQL}
     WHERE p.id = $1`,
    [poolId],
  );
  if (!pool.rowCount) return null;
  const row = pool.rows[0];
  const quote = quoteView(row);
  const [candles, swaps] = await Promise.all([
    db.query<CandleRow>(
      `SELECT start_time, open, high, low, close, volume_qor, COALESCE(volume_quote, volume_qor) AS volume_quote, transactions
       FROM candles WHERE pool_id = $1 AND interval = $2 AND start_time >= NOW() - $3::interval ORDER BY start_time ASC`,
      [poolId, interval, CHART_WINDOWS[interval]],
    ),
    db.query<{ price_b_per_a: string | null } & Record<string, unknown>>("SELECT tx_hash, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a FROM swaps WHERE pool_id = $1 ORDER BY executed_at DESC LIMIT 60", [poolId]),
  ]);
  // Candles in quote per base, ready for the chart whichever side the quote token is on.
  const quoteCandles = !quote.decimals_known ? [] : candles.rows.flatMap((candle) => {
    const oriented = exact(() => candleInQuote(candle, quote.quote_side));
    return oriented ? [{ start_time: oriented.start_time, open: oriented.open, high: oriented.high, low: oriented.low, close: oriented.close, volume: oriented.volume_quote, transactions: oriented.transactions }] : [];
  });
  return {
    pool: { ...row, ...quote },
    candles: candles.rows,
    quote_candles: quoteCandles,
    swaps: swaps.rows.map((swap) => ({ ...swap, price_quote: quote.decimals_known ? exact(() => priceInQuote(swap.price_b_per_a, quote.quote_side)) : null })),
  };
}

const qor = (uqor: string) => toDisplayUnits(uqor, 6);

async function pointsSeason() {
  const run = await db.query<{ computed_at: Date; through_height: string; participants: number; config_hash: string }>(
    "SELECT computed_at, through_height::text, participants, config_hash FROM points_runs WHERE season = $1",
    [pointsConfig.season],
  );
  const row = run.rows[0];
  return {
    id: pointsConfig.season,
    startHeight: pointsConfig.seasonStartHeight,
    endHeight: pointsConfig.seasonEndHeight,
    computedAt: row?.computed_at.toISOString() ?? null,
    throughHeight: row ? Number(row.through_height) : null,
    participants: row?.participants ?? 0,
    rulesVersion: row?.config_hash ?? pointsConfigHash,
  };
}

type ScoreRow = {
  address: string;
  rank: number;
  total_points: string;
  swap_points: string;
  liquidity_points: string;
  pool_points: string;
  activity_points: string;
  active_days: number;
};

function leaderboardEntry(row: ScoreRow) {
  return {
    rank: row.rank,
    address: row.address,
    totalPoints: row.total_points,
    breakdown: { swaps: row.swap_points, liquidity: row.liquidity_points, pools: row.pool_points, activity: row.activity_points },
    activeDays: row.active_days,
  };
}

async function pointsLeaderboard(limit: number, offset: number) {
  const [season, rows] = await Promise.all([
    pointsSeason(),
    db.query<ScoreRow>(
      `SELECT address, rank, total_points::text, swap_points::text, liquidity_points::text, pool_points::text, activity_points::text, active_days
       FROM points_scores WHERE season = $1 ORDER BY rank ASC LIMIT $2 OFFSET $3`,
      [pointsConfig.season, limit, offset],
    ),
  ]);
  return { season, entries: rows.rows.map(leaderboardEntry), pagination: { limit, offset, total: season.participants } };
}

async function pointsAddress(address: string) {
  const [season, score, pools, days] = await Promise.all([
    pointsSeason(),
    db.query<ScoreRow & { swap_volume_uqor: string; round_trip_volume_uqor: string; liquidity_uqor_hours: string; pools_created: number; pools_unlocked: number }>(
      `SELECT address, rank, total_points::text, swap_points::text, liquidity_points::text, pool_points::text, activity_points::text, active_days,
              swap_volume_uqor::text, round_trip_volume_uqor::text, liquidity_uqor_hours::text, pools_created, pools_unlocked
       FROM points_scores WHERE season = $1 AND address = $2`,
      [pointsConfig.season, address],
    ),
    db.query<{ pool_id: string; distinct_traders: number; status: string; points: string }>(
      `SELECT pool_id::text, distinct_traders, status, points::text FROM points_pool_bonuses
       WHERE season = $1 AND creator = $2 ORDER BY pool_id ASC`,
      [pointsConfig.season, address],
    ),
    db.query<{ day: string; swap_volume_uqor: string; round_trip_volume_uqor: string; swap_points: string; liquidity_points: string; active: boolean }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, swap_volume_uqor::text, round_trip_volume_uqor::text, swap_points::text, liquidity_points::text, active
       FROM points_daily WHERE season = $1 AND address = $2 ORDER BY day DESC LIMIT 90`,
      [pointsConfig.season, address],
    ),
  ]);
  // Excluded and not yet scored addresses read the same: unranked with zero points.
  const row = score.rows[0];
  const excluded = pointsConfig.excludedAddresses.includes(address);
  return {
    season,
    address,
    ranked: Boolean(row) && !excluded,
    rank: row && !excluded ? row.rank : null,
    totalPoints: row && !excluded ? row.total_points : "0",
    breakdown: row && !excluded
      ? { swaps: row.swap_points, liquidity: row.liquidity_points, pools: row.pool_points, activity: row.activity_points }
      : { swaps: "0", liquidity: "0", pools: "0", activity: "0" },
    activeDays: row && !excluded ? row.active_days : 0,
    stats: {
      swapVolumeQor: row && !excluded ? qor(row.swap_volume_uqor) : "0",
      roundTripVolumeQor: row && !excluded ? qor(row.round_trip_volume_uqor) : "0",
      liquidityQorHours: row && !excluded ? qor(row.liquidity_uqor_hours) : "0",
      poolsCreated: row && !excluded ? row.pools_created : 0,
      poolsUnlocked: row && !excluded ? row.pools_unlocked : 0,
    },
    pools: excluded ? [] : pools.rows.map((pool) => ({
      poolId: pool.pool_id,
      distinctTraders: pool.distinct_traders,
      requiredTraders: pointsConfig.poolBonusMinTraders,
      status: pool.status,
      points: pool.points,
    })),
    days: excluded || !row ? [] : days.rows.map((day) => ({
      day: day.day,
      swapVolumeQor: qor(day.swap_volume_uqor),
      roundTripVolumeQor: qor(day.round_trip_volume_uqor),
      swapPoints: day.swap_points,
      liquidityPoints: day.liquidity_points,
      active: day.active,
    })),
  };
}

function writeJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    // Liveness only (the process answers). Use it for container restarts: /health is 503 during a long catch-up.
    if (url.pathname === "/livez") return writeJson(response, 200, { ok: true });
    if (url.pathname === "/health") {
      const health = { network: NETWORK.id, ...evaluateIndexerHealth(syncState, HEALTH, new Date()) };
      return writeJson(response, health.ok ? 200 : 503, health);
    }
    const positionsMatch = url.pathname.match(/^\/positions\/([0-9a-zA-Z]+)$/);
    if (positionsMatch) {
      const address = positionsMatch[1].toLowerCase();
      if (!isQorAddress(address)) return writeJson(response, 400, { error: "A valid QoreChain address is required" });
      return writeJson(response, 200, await addressPositions(address));
    }
    if (url.pathname === "/markets") return writeJson(response, 200, { markets: await marketList() });
    const detailMatch = url.pathname.match(/^\/pools\/(\d+)$/);
    if (detailMatch) {
      const interval = url.searchParams.get("interval") ?? "1m";
      if (!Object.prototype.hasOwnProperty.call(CHART_WINDOWS, interval)) return writeJson(response, 400, { error: "Unsupported chart interval" });
      const detail = await poolDetail(detailMatch[1], interval);
      return detail ? writeJson(response, 200, detail) : writeJson(response, 404, { error: "Pool not found" });
    }
    // Points stay invisible until the program is switched on.
    if (url.pathname.startsWith("/points/") && pointsConfig.enabled) {
      if (url.pathname === "/points/leaderboard") {
        const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 100);
        const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
        return writeJson(response, 200, await pointsLeaderboard(limit, offset));
      }
      const addressMatch = url.pathname.match(/^\/points\/addresses\/([0-9a-zA-Z]+)$/);
      if (addressMatch) {
        const address = addressMatch[1].toLowerCase();
        if (!isQorAddress(address)) return writeJson(response, 400, { error: "A valid QoreChain address is required" });
        return writeJson(response, 200, await pointsAddress(address));
      }
    }
    return writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Indexer API request failed", error);
    return writeJson(response, 502, { error: "Market data is temporarily unavailable" });
  }
});

/**
 * Refuses to index unless the RPC node, the REST gateway and this database
 * all belong to the configured network. The first start labels the database
 * with its chain id (indexer_state.chain_id). An unreachable chain is retried;
 * a mismatch throws, and the process exits before writing any chain data.
 */
async function verifyChain() {
  for (;;) {
    let rpcChain: string;
    let restChain: string;
    try {
      [rpcChain, restChain] = await Promise.all([chainStatus().then((status) => status.network), restChainId()]);
    } catch {
      console.error(`Cannot reach QoreChain at ${RPC_URL} and ${REST_URL} to verify the chain id; retrying in 10 seconds`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (restChain !== rpcChain) {
      throw new Error(`QORECHAIN_REST_URL serves ${restChain || "an unknown chain"} but QORECHAIN_RPC_URL serves ${rpcChain || "an unknown chain"}. Point both at the same network.`);
    }
    const [stored, data] = await Promise.all([
      getState("chain_id"),
      db.query<{ has_data: boolean }>("SELECT EXISTS (SELECT 1 FROM indexer_state WHERE key = 'last_indexed_height') OR EXISTS (SELECT 1 FROM pools) AS has_data"),
    ]);
    const verdict = chainGuard({
      configured: NETWORK.chainId,
      node: rpcChain,
      stored: stored ?? null,
      databaseHasData: Boolean(data.rows[0]?.has_data),
      adopt: process.env.QWAKK_INDEXER_ADOPT_CHAIN_ID?.trim() || null,
    });
    if (verdict.action === "refuse") throw new Error(verdict.reason);
    if (verdict.action === "store") {
      await setState("chain_id", verdict.chainId);
      console.log(`Database labelled with chain id ${verdict.chainId}`);
    }
    syncState.chainId = NETWORK.chainId;
    return;
  }
}

async function main() {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  await db.query(await readFile(schemaPath, "utf8"));
  for (const warning of [...configWarnings, ...pointsWarnings.map((warning) => `Points config: ${warning}`)]) console.warn(warning);
  console.log(`Indexing ${NETWORK.id} (${NETWORK.chainId}) from ${RPC_URL} and ${REST_URL}`);
  // Health answers while the chain id is verified; it reads "starting" until the first sync.
  server.listen(PORT, () => console.log(`Qwakk indexer listening on ${PORT}`));
  await verifyChain();
  const saved = Number(await getState("last_indexed_height") ?? 0);
  syncState.height = saved > 0 ? saved : null;
  // Before the first sync tick, so a live swap cannot land in a bucket that is being filled.
  // A failure is logged and retried on the next start; it never stops indexing.
  await backfillRolledUpCandles().catch((error) => console.warn("Candle backfill failed, it runs again on the next start:", error instanceof Error ? error.message : error));
  void runSync();
  setInterval(() => void runSync(), 5_000).unref();
  // Raw liquidity data is collected and scored even while the public points API is off,
  // because LP history cannot be read back from the chain later.
  setInterval(() => void runSnapshots(), SNAPSHOT_CHECK_MS).unref();
  setInterval(() => void runScoring(), SCORING_INTERVAL_MS).unref();
  setTimeout(() => void runSnapshots(), 10_000).unref();
  setTimeout(() => void runScoring(), 30_000).unref();
  if (RETENTION.enabled) {
    console.log(`Retention every ${RETENTION.intervalMinutes} minutes: 1m candles ${RETENTION.candles1mDays || "kept"} days, 5m candles ${RETENTION.candles5mDays || "kept"} days, swap raw events ${RETENTION.swapRawEventDays || "kept"} days, LP snapshots ${pointsConfig.seasonStartHeight > 0 ? `below season start height ${pointsConfig.seasonStartHeight}` : `${RETENTION.lpSnapshotDays || "kept"} days`}`);
    setTimeout(() => void runRetention(), 60_000).unref();
    setInterval(() => void runRetention(), RETENTION.intervalMinutes * 60_000).unref();
  } else {
    console.log("Retention is off (QWAKK_RETENTION)");
  }
}

main().catch((error) => {
  console.error("Qwakk indexer could not start", error);
  process.exit(1);
});
