import { getQwakkNetwork, type QwakkNetwork } from "@/lib/qwakk-network";

/**
 * Confirms the configured endpoints really serve the configured chain before
 * Qwakk prepares a transaction. Both endpoints are checked, because the
 * prepare route reads accounts and simulates over REST while health and the
 * network summary use RPC:
 *
 * - RPC `/status` → `result.node_info.network` (CometBFT);
 * - REST `/cosmos/base/tendermint/v1beta1/node_info` → `default_node_info.network`.
 *
 * Both answered `qorechain-vladi` on mainnet and `qorechain-diana` on the
 * testnet on 2026-10-31.
 */

export type ChainIdCheck =
  | { state: "match"; chainId: string; height: string | null }
  | { state: "mismatch"; expected: string; rpc: string | null; rest: string | null }
  | { state: "unreachable"; expected: string };

/** `result.node_info.network` from a CometBFT `/status` body (also accepts the unwrapped form). */
export function chainIdFromRpcStatus(body: unknown): string | null {
  const record = body as { result?: { node_info?: { network?: unknown } }; node_info?: { network?: unknown } } | null;
  const network = record?.result?.node_info?.network ?? record?.node_info?.network;
  return typeof network === "string" && network ? network : null;
}

export function heightFromRpcStatus(body: unknown): string | null {
  const record = body as { result?: { sync_info?: { latest_block_height?: unknown } } } | null;
  const height = record?.result?.sync_info?.latest_block_height;
  return typeof height === "string" && /^\d+$/.test(height) ? height : null;
}

/** `default_node_info.network` from the Cosmos REST node_info body. */
export function chainIdFromRestNodeInfo(body: unknown): string | null {
  const record = body as { default_node_info?: { network?: unknown } } | null;
  const network = record?.default_node_info?.network;
  return typeof network === "string" && network ? network : null;
}

/** Pure comparison, so tests can cover every outcome. */
export function compareChainIds(expected: string, rpc: string | null, rest: string | null, height: string | null = null): ChainIdCheck {
  if (rpc === null && rest === null) return { state: "unreachable", expected };
  if (rpc !== null && rpc !== expected) return { state: "mismatch", expected, rpc, rest };
  if (rest !== null && rest !== expected) return { state: "mismatch", expected, rpc, rest };
  // One side unreachable but the other matches: report unreachable, so nothing
  // is prepared against an endpoint that could not be checked.
  if (rpc === null || rest === null) return { state: "unreachable", expected };
  return { state: "match", chainId: expected, height };
}

async function readJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    return response.ok ? await response.json() as unknown : null;
  } catch {
    return null;
  }
}

/** Reads both endpoints now, without the cache. */
export async function readChainIdCheck(network: QwakkNetwork = getQwakkNetwork()): Promise<ChainIdCheck> {
  const [status, nodeInfo] = await Promise.all([
    readJson(`${network.rpcUrl}/status`),
    readJson(`${network.restUrl}/cosmos/base/tendermint/v1beta1/node_info`),
  ]);
  return compareChainIds(network.chainId, chainIdFromRpcStatus(status), chainIdFromRestNodeInfo(nodeInfo), heightFromRpcStatus(status));
}

/** A match is trusted for 5 minutes; a mismatch or an outage is re-read after 15 seconds. */
const MATCH_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 15_000;

let cache: { at: number; check: ChainIdCheck } | null = null;
let inFlight: Promise<ChainIdCheck> | null = null;

/** The cached chain id check used before every prepared transaction. */
export async function checkChainId(now = Date.now()): Promise<ChainIdCheck> {
  if (cache) {
    const ttl = cache.check.state === "match" ? MATCH_TTL_MS : FAILURE_TTL_MS;
    if (now - cache.at < ttl) return cache.check;
  }
  if (!inFlight) {
    inFlight = readChainIdCheck()
      .then((check) => {
        if (check.state === "mismatch") console.error("[qwakk-chain-guard] Configured chain id does not match the endpoints", check);
        cache = { at: Date.now(), check };
        return check;
      })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}
