import { indexerRead } from "../../../lib/qwakk-market";
import { cachedJsonResponse, createServerCache, type CachedJson } from "../../../lib/qwakk-server-cache";

/** Every open page polls markets; one indexer read is shared for a few seconds. */
const marketsCache = createServerCache<CachedJson>({
  maxEntries: 1,
  ttlMs: (result) => (result.status === 200 ? 4_000 : 2_000),
});

async function readMarkets(): Promise<CachedJson> {
  const data = await indexerRead("/markets");
  if (!data) return { status: 503, body: { error: "Market data is temporarily unavailable" } };
  return { status: 200, body: data };
}

export async function GET() {
  return cachedJsonResponse(await marketsCache("markets", readMarkets));
}
