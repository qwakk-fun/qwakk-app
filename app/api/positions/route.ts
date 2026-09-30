import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";

type ChainPool = { id?: string | number; token_a?: string; token_b?: string; lp_supply?: string };

const MAX_POOLS = 50;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${QORECHAIN_REST_URL}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("QoreChain query failed");
  return response.json() as Promise<T>;
}

/**
 * The native AMM keeps LP shares in its own store rather than as bank tokens,
 * so positions are read per pool from the AMM LP balance query.
 */
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) return json({ error: "A valid QoreChain address is required" }, 400);

  try {
    const { pools } = await readJson<{ pools?: ChainPool[] }>("/qorechain/amm/v1/pools");
    const candidates = (Array.isArray(pools) ? pools : [])
      .map((pool) => ({ ...pool, id: String(pool.id ?? "") }))
      .filter((pool) => /^\d+$/.test(pool.id))
      .slice(0, MAX_POOLS);

    const balances = await Promise.all(candidates.map(async (pool) => {
      const { balance } = await readJson<{ balance?: string }>(`/qorechain/amm/v1/pools/${pool.id}/lp/${encodeURIComponent(address)}`);
      return { pool, balance: /^\d+$/.test(balance ?? "") ? balance as string : "0" };
    }));

    const positions = balances
      .filter(({ balance }) => BigInt(balance) > BigInt(0))
      .map(({ pool, balance }) => ({
        poolId: pool.id,
        tokenA: pool.token_a ?? "",
        tokenB: pool.token_b ?? "",
        lpBalance: balance,
        lpSupply: /^\d+$/.test(pool.lp_supply ?? "") ? pool.lp_supply : "0",
      }));

    return json({ positions });
  } catch {
    return json({ error: "Liquidity positions are temporarily unavailable" }, 502);
  }
}
