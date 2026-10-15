import { QORECHAIN_REST_URL, QORECHAIN_RPC_URL } from "@/lib/qorechain-endpoints";

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

export async function GET() {
  try {
    const [statusResponse, poolsResponse, paramsResponse] = await Promise.all([
      fetch(`${QORECHAIN_RPC_URL}/status`, { cache: "no-store" }),
      fetch(`${QORECHAIN_REST_URL}/qorechain/amm/v1/pools`, { cache: "no-store" }),
      fetch(`${QORECHAIN_REST_URL}/qorechain/amm/v1/params`, { cache: "no-store" }).catch(() => null),
    ]);

    if (!statusResponse.ok || !poolsResponse.ok) {
      return Response.json({ error: "QoreChain Diana is unavailable" }, { status: 502 });
    }

    const [status, poolData] = await Promise.all([statusResponse.json(), poolsResponse.json()]);
    const params = paramsResponse?.ok ? ((await paramsResponse.json()) as { params?: AmmParams }).params : undefined;
    return Response.json(
      {
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
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Unable to reach QoreChain Diana" }, { status: 502 });
  }
}
