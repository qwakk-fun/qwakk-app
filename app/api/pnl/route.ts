import { indexerRequest } from "@/lib/qwakk-market";
import { cachedJsonResponse, createServerCache, type CachedJson } from "@/lib/qwakk-server-cache";

/**
 * GET /api/pnl?address=qor1...
 *
 * Per-token cost basis and profit and loss of a wallet, valued in QOR with the
 * average-cost method over the wallet's indexed swaps (indexer GET /pnl/:address,
 * engine in indexer/cost-basis.ts, queries in indexer/wallet-pnl.ts, contract in indexer/README.md).
 *
 * 200: { address, method: "average_cost", unit: { denom: "uqor", symbol: "QOR", decimals: 6 },
 *        history: { fromHeight, fromTime, source, indexedHeight, gap },
 *        swapsCounted, totals: { valueUqor, costBasisUqor, unrealizedPnlUqor,
 *        unrealizedPnlPercent, realizedPnlUqor, unpricedTokens, coverage },
 *        tokens: [{ denom, symbol, decimals, held, bought, sold, buys, sells,
 *        costBasisAmount, costBasisUqor, averageCostQor, unknownCostAmount,
 *        untrackedOutflowAmount, price, valueUqor, unrealizedPnlUqor,
 *        unrealizedPnlPercent, realizedPnlUqor, realizedUnknownAmount,
 *        costCoverage, dust }] }
 * Token amounts are base-unit integer strings, *Uqor fields are signed uqor
 * integer strings, *Qor and *Percent fields are decimal strings. Display QOR.
 * 400 invalid address, 422 too many swaps to replay, 503 indexer or chain unavailable.
 * Error bodies are fixed Qwakk copy, never upstream text.
 */

/** Merges bursts for one address; short so the reload after a confirmed swap sees it once indexed. */
const pnlCache = createServerCache<CachedJson>({
  maxEntries: 2_000,
  ttlMs: (result) => (result.status === 200 ? 5_000 : 2_000),
});

async function readPnl(address: string): Promise<CachedJson> {
  const result = await indexerRequest(`/pnl/${encodeURIComponent(address)}`);
  if (result?.status === 200 && result.data) return { status: 200, body: result.data };
  if (result?.status === 400) return { status: 400, body: { error: "A valid QoreChain address is required" } };
  if (result?.status === 422) return { status: 422, body: { error: "This wallet has too many swaps to summarize right now" } };
  return { status: 503, body: { error: "Profit and loss is temporarily unavailable" } };
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim().toLowerCase() ?? "";
  if (!/^qor1[0-9a-z]{20,}$/.test(address)) {
    return cachedJsonResponse({ status: 400, body: { error: "A valid QoreChain address is required" } });
  }
  return cachedJsonResponse(await pnlCache(address, () => readPnl(address)));
}
