import { isMarketRange, type MarketRange, type QorMarket } from "@/lib/qor-price";

const COINGECKO_URL = "https://api.coingecko.com/api/v3";
const COIN_ID = "qorechain";
const CACHE_MS = 60_000;

const cache = new Map<MarketRange, { expires: number; value: QorMarket }>();

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": status === 200 ? "public, max-age=30" : "no-store" } });
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function coingecko<T>(path: string): Promise<T> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  const response = await fetch(`${COINGECKO_URL}${path}`, {
    headers: { Accept: "application/json", ...(key ? { "x-cg-demo-api-key": key } : {}) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Market data request failed");
  return response.json() as Promise<T>;
}

type SimplePrice = Record<string, { usd?: number; usd_24h_change?: number; usd_24h_vol?: number; usd_market_cap?: number }>;
type MarketChart = { prices?: Array<[number, number]> };

async function loadMarket(range: MarketRange): Promise<QorMarket> {
  const [simple, chart] = await Promise.all([
    coingecko<SimplePrice>(`/simple/price?ids=${COIN_ID}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`),
    coingecko<MarketChart>(`/coins/${COIN_ID}/market_chart?vs_currency=usd&days=${range}`),
  ]);
  const quote = simple[COIN_ID];
  const price = finite(quote?.usd);
  if (price === null) throw new Error("Market data had no price");

  const points = (Array.isArray(chart.prices) ? chart.prices : [])
    .filter((point) => Array.isArray(point) && finite(point[0]) !== null && finite(point[1]) !== null)
    .map(([time, value]) => ({ time: Math.floor(time / 1000), price: value }));

  return {
    price,
    change24h: finite(quote?.usd_24h_change),
    volume24h: finite(quote?.usd_24h_vol),
    marketCap: finite(quote?.usd_market_cap),
    range,
    points,
    updatedAt: Date.now(),
  };
}

/**
 * Public QOR/USD market data from CoinGecko. It describes the wider QOR market,
 * not trading on Qwakk, and every surface that shows it names the source.
 */
export async function GET(request: Request) {
  const range = new URL(request.url).searchParams.get("range") ?? "7";
  if (!isMarketRange(range)) return json({ error: "Choose a supported range" }, 400);

  const cached = cache.get(range);
  if (cached && cached.expires > Date.now()) return json(cached.value);

  try {
    const value = await loadMarket(range);
    cache.set(range, { expires: Date.now() + CACHE_MS, value });
    return json(value);
  } catch {
    // A slightly stale answer beats an empty chart when the free API rate-limits.
    if (cached) return json(cached.value);
    return json({ error: "QOR market data is temporarily unavailable" }, 503);
  }
}
