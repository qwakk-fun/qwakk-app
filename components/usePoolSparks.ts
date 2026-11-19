"use client";

import { useEffect, useState } from "react";
import type { SparkSummary } from "../lib/qwakk-chart";

export type PoolSpark = { state: "loading" | "ready" | "unavailable"; summary: SparkSummary | null };

/** A 24 hour line moves at most once an hour, so a read is reused this long. */
const SPARK_TTL_MS = 5 * 60_000;
/** A failed read is retried sooner. */
const SPARK_RETRY_MS = 60_000;
const CHECK_MS = 30_000;

/** Shared by every list on the page and kept across remounts (switching tabs on the pools page). */
const cache = new Map<string, { at: number; summary: SparkSummary | null; failed: boolean }>();
let inflight: Promise<void> | null = null;

function stale(id: string, now: number) {
  const entry = cache.get(id);
  return !entry || now - entry.at > (entry.failed ? SPARK_RETRY_MS : SPARK_TTL_MS);
}

/** One request (`/api/sparks`) for every stale pool; concurrent callers share it. */
function refresh(ids: readonly string[]): Promise<void> {
  if (inflight) return inflight;
  const now = Date.now();
  const wanted = ids.filter((id) => stale(id, now));
  if (!wanted.length) return Promise.resolve();
  inflight = fetch(`/api/sparks?ids=${wanted.join(",")}`, { cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<{ sparks?: Record<string, SparkSummary | null> }> : null)
    .catch(() => null)
    .then((data) => {
      const at = Date.now();
      for (const id of wanted) {
        const summary = data?.sparks?.[id];
        if (summary && Array.isArray(summary.points)) cache.set(id, { at, summary, failed: false });
        // Keep a line already on screen when a refresh fails.
        else cache.set(id, { at, summary: cache.get(id)?.summary ?? null, failed: true });
      }
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function snapshot(ids: readonly string[]) {
  const result: Record<string, PoolSpark> = {};
  for (const id of ids) {
    const entry = cache.get(id);
    result[id] = !entry ? { state: "loading", summary: null } : { state: entry.summary ? "ready" : "unavailable", summary: entry.summary };
  }
  return result;
}

/**
 * 24 hour sparklines for a list of pools, read in one batch and cached for a
 * few minutes across the page. Polling pauses while the tab is hidden and
 * catches up when it is shown again.
 */
export function usePoolSparks(ids: readonly string[]): Record<string, PoolSpark> {
  const key = ids.join(",");
  const [sparks, setSparks] = useState<{ key: string; value: Record<string, PoolSpark> }>({ key: "", value: {} });

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!list.length) return;
    let active = true;
    const update = () => { if (active) setSparks({ key, value: snapshot(list) }); };
    const load = () => {
      if (document.hidden) return;
      void refresh(list).then(update);
    };
    const timer0 = window.setTimeout(() => { update(); load(); }, 0);
    const timer = window.setInterval(load, CHECK_MS);
    document.addEventListener("visibilitychange", load);
    return () => { active = false; window.clearTimeout(timer0); window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [key]);

  return sparks.key === key ? sparks.value : snapshot(ids);
}
