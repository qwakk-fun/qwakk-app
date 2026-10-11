import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { priceBPerA, toDisplayUnits } from "./market-math";

const REST_URL = (process.env.QORECHAIN_REST_URL ?? "https://api-testnet.qore.host").replace(/\/$/, "");
const RPC_URL = (process.env.QORECHAIN_RPC_URL ?? "https://rpc-testnet.qore.host").replace(/\/$/, "");
const PORT = Number(process.env.QWAKK_INDEXER_PORT ?? 4400);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://qwakk:qwakk_local@localhost:5438/qwakk";
/** Optional first block for a fresh database. It must still be kept by the node. */
const START_HEIGHT = Number(process.env.QWAKK_INDEXER_START_HEIGHT ?? 0);
const db = new Pool({ connectionString: DATABASE_URL });

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

type EventAttribute = { key?: string; value?: string };
type ChainEvent = { type?: string; attributes?: EventAttribute[] };

const intervals: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "6h": 21600, "1d": 86400 };

/** How far back each chart interval reaches. */
const chartWindows: Record<string, string> = { "1m": "24 hours", "5m": "3 days", "1h": "30 days", "1d": "365 days" };

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
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`QoreChain request failed with ${response.status}`);
  return response.json() as Promise<T>;
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
  try {
    const result = await fetchJson<{ metadata?: { symbol?: string; name?: string; display?: string; uri?: string; denom_units?: Array<{ denom?: string; exponent?: number }> } }>(
      `${REST_URL}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`,
    );
    const source = result.metadata;
    if (source) {
      symbol = source.symbol || source.display || symbol;
      name = source.name || null;
      decimals = Math.max(...(source.denom_units ?? []).map((unit) => Number(unit.exponent ?? 0)), decimals);
      imageUrl = source.uri || null;
      metadata = source;
    }
  } catch {
    // A missing token registry record must never stop an on-chain pool from appearing.
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

function attributes(event: ChainEvent) {
  // CometBFT 0.38 returns event attributes as plain strings.
  return Object.fromEntries((event.attributes ?? []).map((attribute) => [attribute.key ?? "", attribute.value ?? ""]));
}

function bucketStart(date: Date, seconds: number) {
  return new Date(Math.floor(date.getTime() / (seconds * 1000)) * seconds * 1000);
}

async function recordCandle(poolId: string, executedAt: Date, price: string, volumeQor: string | null) {
  for (const [interval, seconds] of Object.entries(intervals)) {
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

async function recordSwap(event: ChainEvent, executedAt: Date, height: number, txHash: string, eventIndex: number) {
  const values = attributes(event);
  const poolId = values.pool_id;
  const amountIn = values.amount_in;
  const amountOut = values.amount_out;
  const denomIn = values.denom_in;
  const denomOut = values.denom_out;
  if (!/^\d+$/.test(poolId ?? "") || !/^\d+$/.test(amountIn ?? "") || !/^\d+$/.test(amountOut ?? "") || !denomIn || !denomOut) return;

  const poolResult = await db.query<{ token_a: string; token_b: string }>("SELECT token_a, token_b FROM pools WHERE id = $1", [poolId]);
  const pool = poolResult.rows[0];
  if (!pool) return;
  const tokenResult = await db.query<{ denom: string; decimals: number }>("SELECT denom, decimals FROM tokens WHERE denom = ANY($1)", [[pool.token_a, pool.token_b]]);
  const decimals = new Map(tokenResult.rows.map((token) => [token.denom, Number(token.decimals)]));
  if (BigInt(amountIn) === BigInt(0) || BigInt(amountOut) === BigInt(0)) return;
  const decimalsA = decimals.get(pool.token_a) ?? 0;
  const decimalsB = decimals.get(pool.token_b) ?? 0;
  const price = denomIn === pool.token_a && denomOut === pool.token_b
    ? priceBPerA(amountIn, decimalsA, amountOut, decimalsB)
    : denomIn === pool.token_b && denomOut === pool.token_a
      ? priceBPerA(amountOut, decimalsA, amountIn, decimalsB)
      : null;
  const volumeQor = denomIn === "uqor"
    ? toDisplayUnits(amountIn, decimals.get("uqor") ?? 6)
    : denomOut === "uqor" ? toDisplayUnits(amountOut, decimals.get("uqor") ?? 6) : null;
  const inserted = await db.query(
    `INSERT INTO swaps (tx_hash, event_index, pool_id, height, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a, raw_event)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tx_hash, event_index) DO NOTHING`,
    [txHash, eventIndex, poolId, height, executedAt, values.sender || null, denomIn, amountIn, denomOut, amountOut, price, values],
  );
  if (inserted.rowCount && price !== null) await recordCandle(poolId, executedAt, price, volumeQor);
}

async function processBlock(height: number) {
  const [blockData, resultsData] = await Promise.all([
    fetchJson<{ result?: { block?: { header?: { time?: string }; data?: { txs?: string[] } } } }>(`${RPC_URL}/block?height=${height}`),
    fetchJson<{ result?: { txs_results?: Array<{ events?: ChainEvent[] }> } }>(`${RPC_URL}/block_results?height=${height}`),
  ]);
  const timestamp = new Date(blockData.result?.block?.header?.time ?? Date.now());
  const txs = blockData.result?.block?.data?.txs ?? [];
  const results = resultsData.result?.txs_results ?? [];
  for (const [index, result] of results.entries()) {
    const tx = txs[index] ?? `${height}:${index}`;
    const txHash = tx.includes(":") ? tx : createHash("sha256").update(Buffer.from(tx, "base64")).digest("hex").toUpperCase();
    for (const [eventIndex, event] of (result.events ?? []).entries()) {
      if (event.type === "amm_swap") await recordSwap(event, timestamp, height, txHash, eventIndex);
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
  const until = Math.min(currentHeight, savedHeight + 30);
  for (let height = savedHeight + 1; height <= until; height += 1) {
    await processBlock(height);
    await setState("last_indexed_height", String(height));
  }
}

async function sync() {
  await refreshPools();
  await syncBlocks();
}

let syncInProgress = false;

async function runSync() {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    await sync();
  } catch (error) {
    console.error("Indexer sync failed", error);
  } finally {
    syncInProgress = false;
  }
}

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
    db.query("SELECT start_time, open, high, low, close, volume_qor, transactions FROM candles WHERE pool_id = $1 AND interval = $2 AND start_time >= NOW() - $3::interval ORDER BY start_time ASC", [poolId, interval, chartWindows[interval]]),
    db.query("SELECT tx_hash, executed_at, sender, denom_in, amount_in, denom_out, amount_out, price_b_per_a FROM swaps WHERE pool_id = $1 ORDER BY executed_at DESC LIMIT 60", [poolId]),
  ]);
  return { pool: pool.rows[0], candles: candles.rows, swaps: swaps.rows };
}

function writeJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") return writeJson(response, 200, { ok: true });
    if (url.pathname === "/markets") return writeJson(response, 200, { markets: await marketList() });
    const detailMatch = url.pathname.match(/^\/pools\/(\d+)$/);
    if (detailMatch) {
      const interval = url.searchParams.get("interval") ?? "1m";
      if (!chartWindows[interval]) return writeJson(response, 400, { error: "Unsupported chart interval" });
      const detail = await poolDetail(detailMatch[1], interval);
      return detail ? writeJson(response, 200, detail) : writeJson(response, 404, { error: "Pool not found" });
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
  server.listen(PORT, () => console.log(`Qwakk indexer listening on ${PORT}`));
  void runSync();
  setInterval(() => void runSync(), 5_000).unref();
}

main().catch((error) => {
  console.error("Qwakk indexer could not start", error);
  process.exit(1);
});
