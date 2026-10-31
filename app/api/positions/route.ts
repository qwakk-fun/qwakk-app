import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import { cachedJsonResponse, createServerCache, type CachedJson } from "@/lib/qwakk-server-cache";

type ChainPool = { id?: string | number; token_a?: string; token_b?: string; lp_supply?: string };
type Candidate = ChainPool & { id: string };

/** Pools checked per address. Each one is an upstream LP balance read. */
const MAX_POOLS = 50;
/** LP balance reads in flight at once for one address. */
const LP_READ_CONCURRENCY = 6;
/** One upstream read gives up after this long. */
const READ_TIMEOUT_MS = 8_000;
/** The whole LP read stage for one address gives up after this long. */
const POSITIONS_DEADLINE_MS = 20_000;

/** The pool list is the same for every address, so it is shared for a while. */
const poolsCache = createServerCache<Candidate[] | null>({
  maxEntries: 1,
  ttlMs: (pools) => (pools ? 10_000 : 2_000),
});

/**
 * Positions per address, bounded in count. The TTL only merges bursts for the
 * same address; it stays short so the reload after a confirmed transaction
 * (profile page) sees the new LP balance.
 */
const positionsCache = createServerCache<CachedJson>({
  maxEntries: 2_000,
  ttlMs: () => 3_000,
});

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
  const response = await fetch(`${QORECHAIN_REST_URL}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) throw new Error("QoreChain query failed");
  return response.json() as Promise<T>;
}

async function readPools(): Promise<Candidate[] | null> {
  try {
    const { pools } = await readJson<{ pools?: ChainPool[] }>("/qorechain/amm/v1/pools");
    return (Array.isArray(pools) ? pools : [])
      .map((pool) => ({ ...pool, id: String(pool.id ?? "") }))
      .filter((pool) => /^\d+$/.test(pool.id))
      .slice(0, MAX_POOLS);
  } catch {
    return null;
  }
}

/** Runs `task` over `items` with at most `limit` in flight; the first failure stops new work. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The native AMM keeps LP shares in its own store rather than as bank tokens,
 * so positions are read per pool from the AMM LP balance query.
 */
async function readPositions(address: string): Promise<CachedJson> {
  const unavailable = { status: 502, body: { error: "Liquidity positions are temporarily unavailable" } };
  const candidates = await poolsCache("pools", readPools);
  if (!candidates) return unavailable;

  try {
    const deadline = AbortSignal.timeout(POSITIONS_DEADLINE_MS);
    const balances = await mapWithConcurrency(candidates, LP_READ_CONCURRENCY, async (pool) => {
      const { balance } = await readJson<{ balance?: string }>(`/qorechain/amm/v1/pools/${pool.id}/lp/${encodeURIComponent(address)}`, deadline);
      return { pool, balance: /^\d+$/.test(balance ?? "") ? balance as string : "0" };
    });

    const positions = balances
      .filter(({ balance }) => BigInt(balance) > BigInt(0))
      .map(({ pool, balance }) => ({
        poolId: pool.id,
        tokenA: pool.token_a ?? "",
        tokenB: pool.token_b ?? "",
        lpBalance: balance,
        lpSupply: /^\d+$/.test(pool.lp_supply ?? "") ? pool.lp_supply : "0",
      }));

    return { status: 200, body: { positions } };
  } catch {
    return unavailable;
  }
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  if (!/^qor1[0-9a-z]{20,}$/i.test(address)) {
    return cachedJsonResponse({ status: 400, body: { error: "A valid QoreChain address is required" } });
  }
  return cachedJsonResponse(await positionsCache(address.toLowerCase(), () => readPositions(address)));
}
