import { indexerRead } from "../../../lib/qwakk-market";
import { cachedJsonResponse, createServerCache, type CachedJson } from "../../../lib/qwakk-server-cache";

type MarketRow = {
  id: string | number;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: string | number;
  token_b_decimals: string | number;
  transactions_24h: string | number;
};

type SwapRow = {
  tx_hash: string;
  executed_at: string;
  sender: string | null;
  denom_in: string;
  amount_in: string;
  denom_out: string;
  amount_out: string;
};

/** Pools read per request. The busiest pools carry almost every recent swap. */
const POOL_LIMIT = 8;
const SWAP_LIMIT = 60;

/**
 * The live ticker polls this on every page and each call makes up to nine
 * indexer reads, so the merged feed is shared for a few seconds.
 */
const activityCache = createServerCache<CachedJson>({
  maxEntries: 1,
  ttlMs: (result) => (result.status === 200 ? 5_000 : 2_000),
});

/**
 * Recent swaps across the busiest QoreChain Diana pools, newest first. The
 * indexer serves swaps per pool, so this merges them for the live feed.
 */
export async function GET() {
  return cachedJsonResponse(await activityCache("activity", readActivity));
}

async function readActivity(): Promise<CachedJson> {
  const data = await indexerRead("/markets") as { markets?: MarketRow[] } | null;
  if (!data) return { status: 503, body: { error: "Activity is temporarily unavailable" } };
  const markets = (Array.isArray(data.markets) ? data.markets : [])
    .filter((market) => /^\d+$/.test(String(market.id)))
    .sort((a, b) => (Number(b.transactions_24h) || 0) - (Number(a.transactions_24h) || 0))
    .slice(0, POOL_LIMIT);

  // The 1d interval has the fewest candles, so the detail read stays small.
  const details = await Promise.all(markets.map((market) => indexerRead(`/pools/${market.id}?interval=1d`) as Promise<{ swaps?: SwapRow[] } | null>));
  const swaps = details.flatMap((detail, index) => {
    const market = markets[index];
    return (Array.isArray(detail?.swaps) ? detail.swaps : []).map((swap) => ({
      tx_hash: swap.tx_hash,
      executed_at: swap.executed_at,
      sender: swap.sender,
      denom_in: swap.denom_in,
      amount_in: swap.amount_in,
      denom_out: swap.denom_out,
      amount_out: swap.amount_out,
      pool_id: String(market.id),
      token_a: market.token_a,
      token_b: market.token_b,
      token_a_symbol: market.token_a_symbol,
      token_b_symbol: market.token_b_symbol,
      token_a_decimals: Number(market.token_a_decimals) || 0,
      token_b_decimals: Number(market.token_b_decimals) || 0,
    }));
  });
  swaps.sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime());
  return { status: 200, body: { swaps: swaps.slice(0, SWAP_LIMIT) } };
}
