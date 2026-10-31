import { QORECHAIN_REST_URL, QORECHAIN_RPC_URL } from "@/lib/qorechain-endpoints";
import { getQwakkNetwork } from "@/lib/qwakk-network";
import { networkCopy } from "@/lib/qwakk-tx-copy";
import { cachedJsonResponse, createServerCache, type CachedJson } from "@/lib/qwakk-server-cache";

type AmmParams = {
  swap_fee_bps?: number | string;
  protocol_fee_bps?: number | string;
  min_liquidity?: string;
  max_pools_per_creator?: number | string;
  pool_creation_fee?: string;
  max_swap_impact_bps?: number | string;
  lp_token_decimals?: number | string;
  enabled?: boolean;
};

function integerText(value: unknown) {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^\d+$/.test(text) ? text : null;
}

/** Upstream reads give up after this long so a slow node cannot pile up requests. */
const UPSTREAM_TIMEOUT_MS = 6_000;

/**
 * Every open page polls this route, so one upstream read is shared for a few
 * seconds across all clients. Failures are kept briefly too, so an outage does
 * not turn into a retry storm against QoreChain.
 */
const networkCache = createServerCache<CachedJson>({
  maxEntries: 1,
  ttlMs: (result) => (result.status === 200 ? 4_000 : 2_000),
});

function upstream(url: string) {
  return fetch(url, { cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

async function readNetwork(): Promise<CachedJson> {
  try {
    const [statusResponse, poolsResponse, paramsResponse] = await Promise.all([
      upstream(`${QORECHAIN_RPC_URL}/status`),
      upstream(`${QORECHAIN_REST_URL}/qorechain/amm/v1/pools`),
      upstream(`${QORECHAIN_REST_URL}/qorechain/amm/v1/params`).catch(() => null),
    ]);

    if (!statusResponse.ok || !poolsResponse.ok) {
      return { status: 502, body: { error: networkCopy("QoreChain Diana is unavailable", getQwakkNetwork()) } };
    }

    const [status, poolData] = await Promise.all([statusResponse.json(), poolsResponse.json()]);
    const params = paramsResponse?.ok ? ((await paramsResponse.json()) as { params?: AmmParams }).params : undefined;
    return {
      status: 200,
      body: {
        height: status?.result?.sync_info?.latest_block_height ?? null,
        pools: Array.isArray(poolData?.pools) ? poolData.pools : [],
        amm: params ? {
          enabled: params.enabled !== false,
          swapFeeBps: integerText(params.swap_fee_bps),
          protocolFeeBps: integerText(params.protocol_fee_bps),
          minLiquidity: integerText(params.min_liquidity),
          maxPoolsPerCreator: integerText(params.max_pools_per_creator),
          poolCreationFee: integerText(params.pool_creation_fee),
          maxSwapImpactBps: integerText(params.max_swap_impact_bps),
          lpTokenDecimals: integerText(params.lp_token_decimals),
        } : null,
      },
    };
  } catch {
    return { status: 502, body: { error: networkCopy("Unable to reach QoreChain Diana", getQwakkNetwork()) } };
  }
}

export async function GET() {
  return cachedJsonResponse(await networkCache("network", readNetwork));
}
