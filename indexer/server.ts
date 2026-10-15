import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { ensurePoolStored, indexBlockRange, isNotFoundAnswer, type ChainLookup } from "./block-sync";
import { eventValues, isQorAddress, parseLiquidityEvent, parseSwapEvent, transactionSender, type ChainEvent } from "./amm-events";
import { CANDLE_INTERVALS, CHART_WINDOWS, bucketStart, swapTrade, toDisplayUnits } from "./market-math";
import { describePointsConfig, loadPointsConfig } from "./points-config";
import { formatPoints, scoreSeason, type ScoringInput } from "./points-scoring";

const REST_URL = (process.env.QORECHAIN_REST_URL ?? "https://api-testnet.qore.host").replace(/\/$/, "");
const RPC_URL = (process.env.QORECHAIN_RPC_URL ?? "https://rpc-testnet.qore.host").replace(/\/$/, "");
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

function displaySymbol(denom: string) {
  if (denom === "uqor") return "QOR";
  return denom.replace(/^u/, "").toUpperCase();
}

async function upsertToken(denom: string) {
  if (!denom) return;
  const existing = await db.query<{ denom: string }>("SELECT denom FROM tokens WHERE denom = $1", [denom]);
  if (existing.rowCount) return;

  let symbol = displaySymbol(denom);
  let name: string | null = null;
  let decimals = denom === "uqor" ? 6 : 0;
  let imageUrl: string | null = null;
  let metadata: Record<string, unknown> = {};
  // A token without a registry record still appears with default values. A failed
  // read throws instead, so wrong decimals are never stored for good.
  const lookup = await fetchChainLookup<{ metadata?: { symbol?: string; name?: string; display?: string; uri?: string; denom_units?: Array<{ denom?: string; exponent?: number }> } }>(
    `${REST_URL}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`,
  );
  const source = lookup.status === "found" ? lookup.value.metadata : undefined;
  if (source) {
    symbol = source.symbol || source.display || symbol;
    name = source.name || null;
    decimals = Math.max(...(source.denom_units ?? []).map((unit) => Number(unit.exponent ?? 0)), decimals);
    imageUrl = source.uri || null;
    metadata = source;
  }
  await db.query(
    `INSERT INTO tokens (denom, symbol, name, decimals, image_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (denom) DO UPDATE SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals, image_url = EXCLUDED.image_url, metadata = EXCLUDED.metadata, updated_at = NOW()`,
    [denom, symbol, name, decimals, imageUrl, metadata],
  );
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

async function refreshPools() {
  const result = await fetchJson<{ pools?: ChainPool[] }>(`${REST_URL}/qorechain/amm/v1/pools`);
  const pools = Array.isArray(result.pools) ? result.pools.map(normalizePool) : [];
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

async function latestHeight() {
  const status = await fetchJson<{ result?: { sync_info?: { latest_block_height?: string } } }>(`${RPC_URL}/status`);
  const height = Number(status.result?.sync_info?.latest_block_height ?? 0);
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error("QoreChain did not return a valid block height");
  return height;
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

async function recordCandle(poolId: string, executedAt: Date, price: string, volumeQor: string | null) {
  for (const [interval, seconds] of Object.entries(CANDLE_INTERVALS)) {
    await db.query(
      `INSERT INTO candles (pool_id, interval, start_time, open, high, low, close, volume_qor, transactions)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, 1)
       ON CONFLICT (pool_id, interval, start_time) DO UPDATE SET
         high = GREATEST(candles.high, EXCLUDED.high),
         low = LEAST(candles.low, EXCLUDED.low),
         close = EXCLUDED.close,
         volume_qor = CASE WHEN candles.volume_qor IS NULL AND EXCLUDED.volume_qor IS NULL THEN NULL ELSE COALESCE(candles.volume_qor, 0) + COALESCE(EXCLUDED.volume_qor, 0) END,
         transactions = candles.transactions + 1`,
      [poolId, interval, bucketStart(executedAt, seconds), price, volumeQor],
    );
  }
}

async function recordSwap(event: ChainEvent, executedAt: Date, height: number, txHash: string, eventIndex: number, txSender: string | null) {
  const values = eventValues(event);
  const swap = parseSwapEvent(values, txSender);
  if (!swap || !await ensurePool(swap.poolId)) return;

  const poolResult = await db.query<{ token_a: string; token_b: string }>("SELECT token_a, token_b FROM pools WHERE id = $1", [swap.poolId]);
  const pool = poolResult.rows[0];
  if (!pool) return;
  const tokenResult = await db.query<{ denom: string; decimals: number }>("SELECT denom, decimals FROM tokens WHERE denom = ANY($1)", [[pool.token_a, pool.token_b, "uqor"]]);
  const decimals = new Map(tokenResult.rows.map((token) => [token.denom, Number(token.decimals)]));
  const { price, volumeQor } = swapTrade(swap, {
    tokenA: pool.token_a,
    tokenB: pool.token_b,
    decimalsA: decimals.get(pool.token_a) ?? 0,
    decimalsB: decimals.get(pool.token_b) ?? 0,
    qorDecimals: decimals.get("uqor") ?? 6,
  });
  const inserted = await db.query(
    `INSERT INTO swaps (tx_hash, event_index, pool_id, height, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tx_hash, event_index) DO NOTHING`,
    [txHash, eventIndex, swap.poolId, height, executedAt, swap.sender, swap.denomIn, swap.amountIn, swap.denomOut, swap.amountOut, price, values],
  );
  if (inserted.rowCount && price !== null) await recordCandle(swap.poolId, executedAt, price, volumeQor);
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

async function syncBlocks() {
  const currentHeight = await latestHeight();
  const savedHeight = Number(await getState("last_indexed_height") ?? 0);
  if (!savedHeight) {
    const start = Number.isSafeInteger(START_HEIGHT) && START_HEIGHT > 0 && START_HEIGHT <= currentHeight ? START_HEIGHT - 1 : currentHeight;
    await setState("last_indexed_height", String(start));
    return;
  }
  // A failing block throws before its height is saved, so the next tick retries it.
  await indexBlockRange(savedHeight, Math.min(currentHeight, savedHeight + 30), {
    processBlock,
    saveHeight: (height) => setState("last_indexed_height", String(height)),
  });
}

async function sync() {
  await refreshPools();
  await syncBlocks();
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

async function marketList() {
  const result = await db.query(
    `SELECT p.id, p.pool_type, p.status, p.token_a, p.token_b, p.created_height,
            a.symbol AS token_a_symbol, a.decimals AS token_a_decimals, a.image_url AS token_a_image,
            b.symbol AS token_b_symbol, b.decimals AS token_b_decimals, b.image_url AS token_b_image,
            snapshot.reserve_a, snapshot.reserve_b, snapshot.weighted_avg_price, snapshot.observed_at,
            COALESCE(metrics.transactions_24h, 0) AS transactions_24h,
            volume.volume_qor_24h,
            latest_candle.close AS price_b_per_a,
            earlier_candle.close AS price_24h_ago
     FROM pools p
     JOIN tokens a ON a.denom = p.token_a
     JOIN tokens b ON b.denom = p.token_b
     LEFT JOIN LATERAL (SELECT * FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
     LEFT JOIN LATERAL (SELECT COUNT(*)::int AS transactions_24h FROM swaps WHERE pool_id = p.id AND executed_at >= NOW() - INTERVAL '24 hours') metrics ON true
     LEFT JOIN LATERAL (SELECT SUM(volume_qor) AS volume_qor_24h FROM candles WHERE pool_id = p.id AND interval = '1m' AND start_time >= NOW() - INTERVAL '24 hours') volume ON true
     LEFT JOIN LATERAL (SELECT close FROM candles WHERE pool_id = p.id AND interval = '1m' ORDER BY start_time DESC LIMIT 1) latest_candle ON true
     LEFT JOIN LATERAL (SELECT close FROM candles WHERE pool_id = p.id AND interval = '1m' AND start_time <= NOW() - INTERVAL '24 hours' ORDER BY start_time DESC LIMIT 1) earlier_candle ON true
     ORDER BY snapshot.observed_at DESC NULLS LAST, p.id DESC`,
  );
  return result.rows;
}

async function poolDetail(poolId: string, interval: string) {
  const pool = await db.query(
    `SELECT p.*, a.symbol AS token_a_symbol, a.name AS token_a_name, a.decimals AS token_a_decimals, a.image_url AS token_a_image,
            b.symbol AS token_b_symbol, b.name AS token_b_name, b.decimals AS token_b_decimals, b.image_url AS token_b_image,
            snapshot.reserve_a, snapshot.reserve_b, snapshot.lp_supply, snapshot.weighted_avg_price, snapshot.observed_at
     FROM pools p
     JOIN tokens a ON a.denom = p.token_a
     JOIN tokens b ON b.denom = p.token_b
     LEFT JOIN LATERAL (SELECT * FROM pool_snapshots WHERE pool_id = p.id ORDER BY observed_at DESC LIMIT 1) snapshot ON true
     WHERE p.id = $1`,
    [poolId],
  );
  if (!pool.rowCount) return null;
  const [candles, swaps] = await Promise.all([
    db.query("SELECT start_time, open, high, low, close, volume_qor, transactions FROM candles WHERE pool_id = $1 AND interval = $2 AND start_time >= NOW() - $3::interval ORDER BY start_time ASC", [poolId, interval, CHART_WINDOWS[interval]]),
    db.query("SELECT tx_hash, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a FROM swaps WHERE pool_id = $1 ORDER BY executed_at DESC LIMIT 60", [poolId]),
  ]);
  return { pool: pool.rows[0], candles: candles.rows, swaps: swaps.rows };
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
    if (url.pathname === "/health") return writeJson(response, 200, { ok: true });
    if (url.pathname === "/markets") return writeJson(response, 200, { markets: await marketList() });
    const detailMatch = url.pathname.match(/^\/pools\/(\d+)$/);
    if (detailMatch) {
      const interval = url.searchParams.get("interval") ?? "1m";
      if (!CHART_WINDOWS[interval]) return writeJson(response, 400, { error: "Unsupported chart interval" });
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

async function main() {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  await db.query(await readFile(schemaPath, "utf8"));
  for (const warning of pointsWarnings) console.warn(`Points config: ${warning}`);
  server.listen(PORT, () => console.log(`Qwakk indexer listening on ${PORT}`));
  void runSync();
  setInterval(() => void runSync(), 5_000).unref();
  // Raw liquidity data is collected and scored even while the public points API is off,
  // because LP history cannot be read back from the chain later.
  setInterval(() => void runSnapshots(), SNAPSHOT_CHECK_MS).unref();
  setInterval(() => void runScoring(), SCORING_INTERVAL_MS).unref();
  setTimeout(() => void runSnapshots(), 10_000).unref();
  setTimeout(() => void runScoring(), 30_000).unref();
}

main().catch((error) => {
  console.error("Qwakk indexer could not start", error);
  process.exit(1);
});
