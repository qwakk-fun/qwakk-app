import { readAmmParams, readAmmPool, readQuoteExactIn, readQuoteExactOut } from "@/lib/qwakk-amm-chain";
import { getServerQwakkFeeConfig } from "@/lib/qwakk-fee-config";
import { isBlocked, nativeBlocklist } from "@/lib/qwakk-native-guards";
import { getQwakkNetwork, requiresChainQuote } from "@/lib/qwakk-network";
import { QuoteError, buildExactInQuoteRequest, buildExactOutQuoteRequest, buildExactOutSwapQuote, buildSwapQuote } from "@/lib/qwakk-quote";
import { EXACT_OUT_TOO_LARGE_COPY, PREPARE_GUARD_COPY, QUOTE_FAILURE_COPY, networkCopy } from "@/lib/qwakk-tx-copy";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function parseSlippage(value: string | null) {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number(value);
}

/** Builder errors are fixed strings written in this codebase, never chain text. */
const SAFE_INPUT_ERRORS = new Set([
  "A valid pool ID is required",
  "A valid input denom is required",
  "Swap amount must be a positive integer",
  "Swap amount is too small after the interface fee",
  "Receive amount must be a positive integer",
  "Slippage must be between 1 and 500 bps",
]);

function quoteFailure(error: unknown, network: ReturnType<typeof getQwakkNetwork>, exactOut: boolean) {
  if (error instanceof QuoteError) {
    const status = error.failure === "pool_not_found" ? 404 : error.failure === "unavailable" ? 502 : 422;
    const text = exactOut && error.failure === "insufficient_liquidity" ? EXACT_OUT_TOO_LARGE_COPY : QUOTE_FAILURE_COPY[error.failure];
    return json({ error: networkCopy(text, network), failure: error.failure }, status);
  }
  return json({ error: networkCopy(QUOTE_FAILURE_COPY.unavailable, network), failure: "unavailable" }, 502);
}

/**
 * Exact out: the trader fixes what they receive. The pool is read first,
 * because QoreChain's QuoteExactOut is asked by output denom.
 */
async function exactOutQuote(url: URL, network: ReturnType<typeof getQwakkNetwork>, blocklist: ReturnType<typeof nativeBlocklist>) {
  let quoteRequest;
  try {
    quoteRequest = buildExactOutQuoteRequest({
      poolId: url.searchParams.get("poolId") ?? "",
      denomIn: url.searchParams.get("denomIn") ?? "",
      amountOut: url.searchParams.get("amountOut") ?? "",
      slippageBps: parseSlippage(url.searchParams.get("slippageBps")),
      fee: getServerQwakkFeeConfig(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return json({ error: SAFE_INPUT_ERRORS.has(message) ? message : "Check the swap details" }, 400);
  }

  try {
    const [pool, params] = await Promise.all([readAmmPool(quoteRequest.poolId), readAmmParams()]);
    if (!pool) return json({ error: networkCopy(QUOTE_FAILURE_COPY.pool_not_found, network), failure: "pool_not_found" }, 404);
    if (isBlocked(blocklist, { poolId: quoteRequest.poolId, denoms: [pool.tokenA, pool.tokenB] })) {
      return json({ error: PREPARE_GUARD_COPY.blocked, failure: "blocked" }, 403);
    }
    if (quoteRequest.denomIn !== pool.tokenA && quoteRequest.denomIn !== pool.tokenB) throw new QuoteError("pair");
    if (pool.poolType !== "constant_product") throw new QuoteError("exact_out_unsupported");
    const denomOut = quoteRequest.denomIn === pool.tokenA ? pool.tokenB : pool.tokenA;
    const chain = await readQuoteExactOut(quoteRequest.poolId, denomOut, quoteRequest.amountOut);
    const quote = buildExactOutSwapQuote({ request: quoteRequest, pool, params, chain, allowEstimate: !requiresChainQuote(network) });
    return json({ network: network.chainId, ...quote });
  } catch (error) {
    return quoteFailure(error, network, true);
  }
}

/**
 * Read-only swap quote. The output comes from QoreChain's own
 * `QuoteExactIn` for the amount that reaches the AMM after Qwakk's interface
 * fee, priced against the pool's current reserves. It never signs or
 * broadcasts anything.
 *
 * Query: `poolId`, `denomIn`, `amountIn` (total, base units), `slippageBps`.
 * For an exact-out quote send `amountOut` (base units of the pool's other
 * token) instead of `amountIn`: the answer then comes from QoreChain's
 * `QuoteExactOut`, with `maxIn` and `maxTotalIn` as the price protection.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const network = getQwakkNetwork();
  const blocklist = nativeBlocklist();
  if (url.searchParams.has("amountOut")) return exactOutQuote(url, network, blocklist);

  let quoteRequest;
  try {
    quoteRequest = buildExactInQuoteRequest({
      poolId: url.searchParams.get("poolId") ?? "",
      denomIn: url.searchParams.get("denomIn") ?? "",
      amountIn: url.searchParams.get("amountIn") ?? "",
      slippageBps: parseSlippage(url.searchParams.get("slippageBps")),
      fee: getServerQwakkFeeConfig(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return json({ error: SAFE_INPUT_ERRORS.has(message) ? message : "Check the swap details" }, 400);
  }

  try {
    const [pool, params, chain] = await Promise.all([
      readAmmPool(quoteRequest.poolId),
      readAmmParams(),
      readQuoteExactIn(quoteRequest.poolId, quoteRequest.denomIn, quoteRequest.swapAmountIn),
    ]);
    if (!pool) return json({ error: networkCopy(QUOTE_FAILURE_COPY.pool_not_found, network), failure: "pool_not_found" }, 404);
    if (isBlocked(blocklist, { poolId: quoteRequest.poolId, denoms: [pool.tokenA, pool.tokenB] })) {
      return json({ error: PREPARE_GUARD_COPY.blocked, failure: "blocked" }, 403);
    }
    const quote = buildSwapQuote({ request: quoteRequest, pool, params, chain, allowEstimate: !requiresChainQuote(network) });
    return json({ network: network.chainId, ...quote });
  } catch (error) {
    return quoteFailure(error, network, false);
  }
}
