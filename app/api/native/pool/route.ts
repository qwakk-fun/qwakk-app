import { readAmmParams, readAmmPool, readAmmPoolByDenoms, readLpBalance, type AmmPool } from "@/lib/qwakk-amm-chain";
import { getQwakkNetwork } from "@/lib/qwakk-network";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/;

/**
 * Live pool state straight from the configured network's AMM store, for the moment a
 * trader is about to deposit or withdraw (the indexer can lag a few seconds).
 *
 * `?id=<pool id>[&address=qor1…]` returns the pool, the AMM params the forms
 * need and, with an address, that wallet's LP share balance.
 * `?denomA=&denomB=` looks a pair up in either order, for duplicate checks
 * before creating a pool; `pool` is null when no pool holds the pair.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim() ?? "";
  const address = url.searchParams.get("address")?.trim() ?? "";
  const denomA = url.searchParams.get("denomA")?.trim() ?? "";
  const denomB = url.searchParams.get("denomB")?.trim() ?? "";

  if (address && !/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "A valid QoreChain address is required" }, 400);
  const byId = /^\d+$/.test(id) && BigInt(id) > BigInt(0);
  const byPair = DENOM.test(denomA) && DENOM.test(denomB) && denomA !== denomB;
  if (!byId && !byPair) return json({ error: "A pool ID or two token denoms are required" }, 400);

  try {
    const [pool, params] = await Promise.all([
      byId ? readAmmPool(id) : readAmmPoolByDenoms(denomA, denomB),
      readAmmParams(),
    ]);
    if (byId && !pool) return json({ error: `This pool is not available on ${getQwakkNetwork().label}.` }, 404);
    const lpBalance = pool && address ? await readLpBalance(pool.id, address) : null;
    return json({
      pool: pool as AmmPool | null,
      lpBalance,
      params: {
        enabled: params.enabled,
        swapFeeBps: params.swapFeeBps,
        minLiquidity: params.minLiquidity,
        poolCreationFee: params.poolCreationFee,
        maxSwapImpactBps: params.maxSwapImpactBps,
        lpTokenDecimals: params.lpTokenDecimals,
      },
    });
  } catch {
    return json({ error: "Pool data is temporarily unavailable" }, 502);
  }
}
