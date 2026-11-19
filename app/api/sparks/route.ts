import { indexerRequest } from "../../../lib/qwakk-market";
import { createServerCache } from "../../../lib/qwakk-server-cache";
import { sparkSummary, type SparkSummary } from "../../../lib/qwakk-chart";
import type { ChartCandleInput } from "../../../lib/qwakk-chart";

/**
 * Read only. 24 hour sparklines for the favorites list, many pools in one
 * request: `/api/sparks?ids=6,1,2`. Each pool's 1h candles are read from the
 * indexer and cut down to about 25 points here, so the browser never pulls the
 * full pool payload per favorite. A line changes at most once an hour, so each
 * pool is cached for a few minutes and shared by every visitor.
 */

const MAX_IDS = 100;
/** Indexer reads in flight per request, so a cold list of 100 never floods it. */
const CONCURRENCY = 4;

/** Null: the indexer could not say (down, or no such pool). */
type SparkResult = SparkSummary | null;

const sparkCache = createServerCache<SparkResult>({
  maxEntries: 2_000,
  ttlMs: (result) => (result ? 5 * 60_000 : 30_000),
});

async function readSpark(id: string): Promise<SparkResult> {
  const result = await indexerRequest(`/pools/${id}?interval=1h`);
  const data = result?.status === 200 ? result.data as { quote_candles?: unknown } | null : null;
  if (!data) return null;
  return sparkSummary(Array.isArray(data.quote_candles) ? data.quote_candles as ChartCandleInput[] : []);
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => /^\d{1,20}$/.test(id)))];
  if (ids.length === 0) return json({ sparks: {} });
  if (ids.length > MAX_IDS) return json({ error: "Ask for fewer pools at once" }, 400);

  const sparks: Record<string, SparkResult> = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      sparks[id] = await sparkCache(id, () => readSpark(id));
    }
  }));
  return json({ sparks });
}
