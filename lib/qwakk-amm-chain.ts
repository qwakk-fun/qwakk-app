import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";

/**
 * Read-only views of QoreChain's native x/amm, from the REST routes in
 * qorechain-core `proto/qorechain/amm/v1/query.proto` (documented at
 * docs.qorechain.io/api-reference/rest-grpc-endpoints#amm-module). Server
 * side only, so the browser never calls the node directly.
 */

export type AmmParams = {
  swapFeeBps: number;
  protocolFeeBps: number;
  minLiquidity: string;
  maxPoolsPerCreator: number;
  lpTokenDecimals: number;
  poolCreationFee: string;
  maxSwapImpactBps: number;
  enabled: boolean;
};

export type AmmPool = {
  id: string;
  poolType: "constant_product" | "stable_swap" | string;
  creator: string;
  /** Lexicographically sorted: tokenA < tokenB (`x/amm/types/pool.go`). */
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  lpSupply: string;
  status: "active" | "paused" | string;
  amplificationCoefficient: number;
  /** Block height at creation. */
  createdAt: string;
};

export type ChainQuote =
  | { ok: true; amountOut: string; fee: string }
  | { ok: false; failure: QuoteFailure };

export type QuoteFailure = "pool_not_found" | "impact_too_high" | "insufficient_liquidity" | "pool_paused" | "invalid" | "unavailable";

const TIMEOUT = 8_000;

function integerText(value: unknown) {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^\d+$/.test(text) ? text : null;
}

function integerNumber(value: unknown) {
  const text = integerText(value);
  return text === null ? null : Number(text);
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${QORECHAIN_REST_URL}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** Parses the `params` object of `GET /qorechain/amm/v1/params`. Null if a field is missing. */
export function parseAmmParams(value: unknown): AmmParams | null {
  const params = (value && typeof value === "object" ? (value as { params?: unknown }).params : null) as Record<string, unknown> | null;
  if (!params || typeof params !== "object") return null;
  const swapFeeBps = integerNumber(params.swap_fee_bps);
  const protocolFeeBps = integerNumber(params.protocol_fee_bps);
  const minLiquidity = integerText(params.min_liquidity);
  const maxPoolsPerCreator = integerNumber(params.max_pools_per_creator);
  const lpTokenDecimals = integerNumber(params.lp_token_decimals);
  const poolCreationFee = integerText(params.pool_creation_fee);
  const maxSwapImpactBps = integerNumber(params.max_swap_impact_bps);
  if (swapFeeBps === null || protocolFeeBps === null || minLiquidity === null || maxPoolsPerCreator === null || lpTokenDecimals === null || poolCreationFee === null || maxSwapImpactBps === null) return null;
  return { swapFeeBps, protocolFeeBps, minLiquidity, maxPoolsPerCreator, lpTokenDecimals, poolCreationFee, maxSwapImpactBps, enabled: params.enabled !== false };
}

/** Parses one `PoolView` (snake_case JSON from the REST gateway). */
export function parseAmmPool(value: unknown): AmmPool | null {
  if (!value || typeof value !== "object") return null;
  const pool = value as Record<string, unknown>;
  const id = integerText(pool.id);
  const reserveA = integerText(pool.reserve_a);
  const reserveB = integerText(pool.reserve_b);
  const lpSupply = integerText(pool.lp_supply);
  const tokenA = typeof pool.token_a === "string" ? pool.token_a : "";
  const tokenB = typeof pool.token_b === "string" ? pool.token_b : "";
  if (!id || reserveA === null || reserveB === null || lpSupply === null || !tokenA || !tokenB) return null;
  return {
    id,
    poolType: typeof pool.pool_type === "string" ? pool.pool_type : "",
    creator: typeof pool.creator === "string" ? pool.creator : "",
    tokenA,
    tokenB,
    reserveA,
    reserveB,
    lpSupply,
    status: typeof pool.status === "string" ? pool.status : "",
    amplificationCoefficient: integerNumber(pool.amplification_coefficient) ?? 0,
    createdAt: integerText(pool.created_at) ?? "",
  };
}

let paramsCache: { value: AmmParams; at: number } | null = null;
const PARAMS_TTL = 60_000;

/** AMM params, cached for a minute. They change only by governance. */
export async function readAmmParams(): Promise<AmmParams> {
  if (paramsCache && Date.now() - paramsCache.at < PARAMS_TTL) return paramsCache.value;
  const { status, body } = await getJson("/qorechain/amm/v1/params");
  const params = status === 200 ? parseAmmParams(body) : null;
  if (!params) throw new Error("AMM params are unavailable");
  paramsCache = { value: params, at: Date.now() };
  return params;
}

/** Null when the pool does not exist. Throws when the node cannot be read. */
export async function readAmmPool(poolId: string): Promise<AmmPool | null> {
  if (!/^\d+$/.test(poolId)) return null;
  const { status, body } = await getJson(`/qorechain/amm/v1/pools/${poolId}`);
  if (status === 404) return null;
  const pool = status === 200 ? parseAmmPool((body as { pool?: unknown } | null)?.pool) : null;
  if (!pool) throw new Error("Pool query failed");
  return pool;
}

/** The pool for a denom pair in either order, or null (`pool_by_denoms` is order-independent per the AMM docs). */
export async function readAmmPoolByDenoms(denomA: string, denomB: string): Promise<AmmPool | null> {
  const query = new URLSearchParams({ denom_a: denomA, denom_b: denomB });
  const { status, body } = await getJson(`/qorechain/amm/v1/pool_by_denoms?${query}`);
  if (status === 404) return null;
  const pool = status === 200 ? parseAmmPool((body as { pool?: unknown } | null)?.pool) : null;
  if (!pool) throw new Error("Pool query failed");
  return pool;
}

/** LP shares live in the AMM store, not in bank (`x/amm/types/lp_balance.go`). */
export async function readLpBalance(poolId: string, address: string): Promise<string> {
  const { status, body } = await getJson(`/qorechain/amm/v1/pools/${poolId}/lp/${encodeURIComponent(address)}`);
  const balance = status === 200 ? integerText((body as { balance?: unknown } | null)?.balance) : null;
  if (balance === null) throw new Error("LP balance query failed");
  return balance;
}

/** Maps the keeper's quote error text to a fixed reason. The raw text never leaves the server. */
export function classifyQuoteError(message: string): QuoteFailure {
  const text = message.toLowerCase();
  if (text.includes("not found")) return "pool_not_found";
  if (text.includes("impact")) return "impact_too_high";
  if (text.includes("insufficient liquidity")) return "insufficient_liquidity";
  if (text.includes("paused")) return "pool_paused";
  return "invalid";
}

/**
 * The chain's own exact-in quote: `GET /qorechain/amm/v1/quote/exact_in`,
 * answered by the live keeper (it returns "pool not found" for a missing pool
 * on Diana, checked 2026-10-15). `amount_in` must be the amount that reaches
 * MsgSwapExactIn, after Qwakk's interface fee.
 */
export async function readQuoteExactIn(poolId: string, denomIn: string, amountIn: string): Promise<ChainQuote> {
  const query = new URLSearchParams({ pool_id: poolId, denom_in: denomIn, amount_in: amountIn });
  let result: { status: number; body: unknown };
  try {
    result = await getJson(`/qorechain/amm/v1/quote/exact_in?${query}`);
  } catch {
    return { ok: false, failure: "unavailable" };
  }
  const body = (result.body && typeof result.body === "object" ? result.body : {}) as { amount_out?: unknown; fee?: unknown; message?: unknown };
  if (result.status === 200) {
    const amountOut = integerText(body.amount_out);
    if (amountOut === null) return { ok: false, failure: "unavailable" };
    return { ok: true, amountOut, fee: integerText(body.fee) ?? "0" };
  }
  if (result.status >= 400 && result.status < 500 && typeof body.message === "string") {
    console.warn("QoreChain quote refused", body.message);
    return { ok: false, failure: classifyQuoteError(body.message) };
  }
  return { ok: false, failure: "unavailable" };
}

export type ChainExactOutQuote =
  | { ok: true; amountIn: string; fee: string }
  | { ok: false; failure: QuoteFailure };

/**
 * The chain's own exact-out quote: `GET /qorechain/amm/v1/quote/exact_out`
 * with `pool_id`, `denom_out` and `amount_out` (SDK 0.8.2
 * `QueryQuoteExactOutRequest`), answered as `{ amount_in, fee, impact_bps }`.
 * Checked live on Diana pool 2 on 2026-11-19: `amount_in` is the input that
 * reaches MsgSwapExactOut, swap fee included. A refusal is a 400 with
 * "insufficient liquidity", "impact ... exceeds max_swap_impact_bps",
 * "pool not found", "invalid token denoms" or "invalid amount".
 */
export async function readQuoteExactOut(poolId: string, denomOut: string, amountOut: string): Promise<ChainExactOutQuote> {
  const query = new URLSearchParams({ pool_id: poolId, denom_out: denomOut, amount_out: amountOut });
  let result: { status: number; body: unknown };
  try {
    result = await getJson(`/qorechain/amm/v1/quote/exact_out?${query}`);
  } catch {
    return { ok: false, failure: "unavailable" };
  }
  const body = (result.body && typeof result.body === "object" ? result.body : {}) as { amount_in?: unknown; fee?: unknown; message?: unknown };
  if (result.status === 200) {
    const amountIn = integerText(body.amount_in);
    if (amountIn === null || amountIn === "0") return { ok: false, failure: "unavailable" };
    return { ok: true, amountIn, fee: integerText(body.fee) ?? "0" };
  }
  if (result.status >= 400 && result.status < 500 && typeof body.message === "string") {
    console.warn("QoreChain exact-out quote refused", body.message);
    return { ok: false, failure: classifyQuoteError(body.message) };
  }
  return { ok: false, failure: "unavailable" };
}

/** Bank balances as a denom to base-unit map. */
export async function readBalances(address: string): Promise<Map<string, bigint>> {
  const { status, body } = await getJson(`/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}?pagination.limit=200`);
  if (status !== 200) throw new Error("Balance query failed");
  const balances = (body as { balances?: Array<{ denom?: unknown; amount?: unknown }> } | null)?.balances ?? [];
  const map = new Map<string, bigint>();
  for (const coin of balances) {
    const amount = integerText(coin.amount);
    if (typeof coin.denom === "string" && amount !== null) map.set(coin.denom, BigInt(amount));
  }
  return map;
}
