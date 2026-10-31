/**
 * Operator blocklist for wallet actions, enforced by `/api/native-tx/prepare`
 * before anything is simulated, and by `/api/swap-quote`.
 *
 * - `QWAKK_BLOCKED_POOL_IDS`: comma list of AMM pool ids, for example `3,7`.
 * - `QWAKK_BLOCKED_DENOMS`: comma list of exact denoms, for example
 *   `erc20:0xabc…,ibc/27394…`. Matching ignores case, because the same erc20
 *   or IBC denom can be written in two cases (see lib/qwakk-assets.ts).
 *
 * Both are read per request, so a pool can be paused in CapRover at once.
 */

export type NativeBlocklist = { poolIds: ReadonlySet<string>; denoms: ReadonlySet<string> };
export type BlocklistEnv = Readonly<Record<string, string | undefined>>;

function entries(value: string | undefined) {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

export function parseNativeBlocklist(env: BlocklistEnv): { blocklist: NativeBlocklist; warnings: string[] } {
  const warnings: string[] = [];
  const poolIds = new Set<string>();
  for (const entry of entries(env.QWAKK_BLOCKED_POOL_IDS)) {
    if (/^\d+$/.test(entry) && BigInt(entry) > BigInt(0)) poolIds.add(BigInt(entry).toString());
    else warnings.push(`QWAKK_BLOCKED_POOL_IDS entry "${entry}" is not a pool id. It is ignored.`);
  }
  const denoms = new Set<string>();
  for (const entry of entries(env.QWAKK_BLOCKED_DENOMS)) {
    if (/^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(entry)) denoms.add(entry.toLowerCase());
    else warnings.push(`QWAKK_BLOCKED_DENOMS entry "${entry}" is not a denom. It is ignored.`);
  }
  return { blocklist: { poolIds, denoms }, warnings };
}

export function isPoolBlocked(blocklist: NativeBlocklist, poolId: string) {
  return /^\d+$/.test(poolId) && blocklist.poolIds.has(BigInt(poolId).toString());
}

export function isDenomBlocked(blocklist: NativeBlocklist, denom: string) {
  return Boolean(denom) && blocklist.denoms.has(denom.toLowerCase());
}

/** True when the pool id or any of the given denoms is blocked. */
export function isBlocked(blocklist: NativeBlocklist, target: { poolId?: string; denoms: readonly string[] }) {
  if (target.poolId && isPoolBlocked(blocklist, target.poolId)) return true;
  return target.denoms.some((denom) => isDenomBlocked(blocklist, denom));
}

const warned = new Set<string>();

export function nativeBlocklist(): NativeBlocklist {
  const { blocklist, warnings } = parseNativeBlocklist(process.env);
  for (const warning of warnings) {
    if (warned.has(warning)) continue;
    warned.add(warning);
    console.warn(`[qwakk-blocklist] ${warning}`);
  }
  return blocklist;
}
