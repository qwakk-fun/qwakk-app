"use client";

import { useCallback, useEffect, useState } from "react";
import { resolveUsableAsset, type AssetHint, type UsableAsset } from "../lib/qwakk-asset-resolve";
import { MAX_ASSET_DECIMALS, assetForDenom, type ResolvedAsset } from "../lib/qwakk-assets";

/** The route accepts up to 20 denoms per request. */
const CHUNK_SIZE = 20;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const MAX_ATTEMPTS = 6;

/** Shared across components for the page's lifetime: token details rarely change. */
const resolvedCache = new Map<string, ResolvedAsset>();
const inFlight = new Set<string>();
/** Denoms whose read failed: how often, and when they may be asked for again. */
const failures = new Map<string, { attempts: number; retryAt: number }>();
const listeners = new Set<() => void>();

function isResolvedAsset(value: unknown, denom: string): value is ResolvedAsset {
  const asset = value as Partial<ResolvedAsset> | null;
  return Boolean(asset)
    && asset?.denom === denom
    && typeof asset.symbol === "string"
    && typeof asset.name === "string"
    && (asset.decimals === null || (typeof asset.decimals === "number" && Number.isInteger(asset.decimals) && asset.decimals > 0 && asset.decimals <= MAX_ASSET_DECIMALS));
}

function markFailed(denom: string) {
  const attempts = (failures.get(denom)?.attempts ?? 0) + 1;
  failures.set(denom, { attempts, retryAt: Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)) });
}

async function fetchChunk(denoms: string[]) {
  const query = new URLSearchParams();
  for (const denom of denoms) query.append("denom", denom);
  denoms.forEach((denom) => inFlight.add(denom));
  try {
    const response = await fetch(`/api/native/assets?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json() as { assets?: unknown[] };
    for (const denom of denoms) {
      const match = (data.assets ?? []).find((asset) => isResolvedAsset(asset, denom)) as ResolvedAsset | undefined;
      if (!match) {
        // The server leaves out a denom it could not read: ask again later.
        markFailed(denom);
        continue;
      }
      failures.delete(denom);
      // Only the registry and the server decide labels; the icon is always generic here.
      resolvedCache.set(denom, { denom, symbol: match.symbol, name: match.name, decimals: match.decimals, icon: "generic", source: match.source === "chain" ? "chain" : "unknown" });
    }
  } catch {
    denoms.forEach(markFailed);
  } finally {
    denoms.forEach((denom) => inFlight.delete(denom));
    listeners.forEach((listener) => listener());
  }
}

/**
 * Resolves token details for the given denoms. Curated tokens resolve at once;
 * others are read through `/api/native/assets` (bank metadata on Diana), in
 * chunks of 20, with failed reads retried on a backoff. Until a read succeeds,
 * and whenever metadata does not state them, `decimals` is null and write
 * paths must block. An indexed hint only supplies labels and
 * `displayDecimals`. Denoms are always passed through exactly as the chain
 * reported them.
 */
export function useAssets(denoms: readonly string[]) {
  const key = [...new Set(denoms.filter((denom) => denom && !assetForDenom(denom)))].sort().join("\n");
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, ResolvedAsset>>(() => new Map(resolvedCache));
  // Bumped when a backed-off read is due, so the effect below runs again.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    if (!key) return;
    let active = true;
    const now = Date.now();
    const wanted = key.split("\n");
    const due = wanted.filter((denom) => {
      if (resolvedCache.has(denom) || inFlight.has(denom)) return false;
      const failure = failures.get(denom);
      return !failure || (failure.attempts < MAX_ATTEMPTS && failure.retryAt <= now);
    });
    const sync = () => { if (active) setSnapshot(new Map(resolvedCache)); };
    // Any finished read (this component's or another's) refreshes the snapshot
    // and schedules the next retry, if one is still pending.
    let retryTimer: number | undefined;
    const scheduleRetry = () => {
      let next = Number.POSITIVE_INFINITY;
      for (const denom of wanted) {
        const failure = resolvedCache.has(denom) ? undefined : failures.get(denom);
        if (failure && failure.attempts < MAX_ATTEMPTS) next = Math.min(next, failure.retryAt);
      }
      if (retryTimer !== undefined || !Number.isFinite(next)) return;
      retryTimer = window.setTimeout(() => { if (active) setRetryTick((value) => value + 1); }, Math.max(0, next - Date.now()));
    };
    const onFinished = () => { sync(); scheduleRetry(); };
    listeners.add(onFinished);
    for (let start = 0; start < due.length; start += CHUNK_SIZE) void fetchChunk(due.slice(start, start + CHUNK_SIZE));
    if (!due.length) void Promise.resolve().then(onFinished);
    return () => { active = false; listeners.delete(onFinished); if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [key, retryTick]);

  return useCallback(
    (denom: string, hint?: AssetHint): UsableAsset => resolveUsableAsset(denom, snapshot.get(denom), hint),
    [snapshot],
  );
}
