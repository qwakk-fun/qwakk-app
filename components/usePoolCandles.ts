"use client";

import { useEffect, useState } from "react";
import type { PoolCandle } from "./PoolChart";
import { withAssetOverrides } from "../lib/qwakk-assets";
import type { ChartInterval } from "../lib/qwakk-chart";
import type { QuoteMarket } from "../lib/qwakk-market-view";

/** The `/api/pools/:id` pool fields a price chart needs. */
export type ChartPool = QuoteMarket & { id: string | number };

export type PoolCandlesState = {
  /** `quote_candles`: quote per base, already oriented by the indexer. */
  candles: PoolCandle[];
  pool: ChartPool | null;
  state: "idle" | "loading" | "ready" | "missing" | "unavailable";
};

const IDLE: PoolCandlesState = { candles: [], pool: null, state: "idle" };

/**
 * One pool's price candles from the indexer (`/api/pools/:id`), refreshed on
 * an interval and shortly after a confirmed transaction. An empty `poolId`
 * reads nothing. Results are keyed by pool and interval, so a switched pool
 * never shows the previous pool's candles.
 */
export function usePoolCandles(poolId: string, interval: ChartInterval, refreshMs = 15_000): PoolCandlesState {
  const key = poolId ? `${poolId}|${interval}` : "";
  const [result, setResult] = useState<{ key: string; value: PoolCandlesState }>({ key: "", value: IDLE });

  useEffect(() => {
    if (!key) return;
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/pools/${encodeURIComponent(poolId)}?interval=${interval}`, { cache: "no-store" });
        if (response.status === 404) throw new Error("missing");
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as { pool?: ChartPool; quote_candles?: PoolCandle[] };
        if (!active) return;
        // Curated symbols and decimals win over the indexed token record.
        setResult({ key, value: { candles: Array.isArray(data.quote_candles) ? data.quote_candles : [], pool: data.pool ? withAssetOverrides(data.pool) : null, state: "ready" } });
      } catch (error) {
        if (!active) return;
        const state = error instanceof Error && error.message === "missing" ? "missing" : "unavailable";
        // Keep candles already on screen for this pool when a refresh fails.
        setResult((current) => current.key === key && current.value.state === "ready" ? current : { key, value: { ...IDLE, state } });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    // The indexer polls the chain every few seconds, so read again shortly after a confirmed action.
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qwakk:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qwakk:tx-confirmed", reloadSoon); };
  }, [key, poolId, interval, refreshMs]);

  if (!key) return IDLE;
  return result.key === key ? result.value : { ...IDLE, state: "loading" };
}
