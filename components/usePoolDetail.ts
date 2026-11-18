"use client";

import { useEffect, useState } from "react";
import type { PoolCandle } from "./PoolChart";
import type { PoolSwap } from "./RecentSwaps";
import { withAssetOverrides } from "../lib/qwakk-assets";
import type { ChartInterval } from "../lib/qwakk-chart";
import type { QuoteMarket } from "../lib/qwakk-market-view";

/** The `/api/pools/:id` pool fields the swap page reads. */
export type DetailPool = QuoteMarket & {
  id: string | number;
  status?: string;
  token_a_decimals: string | number | null;
  token_b_decimals: string | number | null;
  transactions_24h?: string | number | null;
};

export type PoolDetailState = {
  /** `quote_candles`: quote per base, already oriented by the indexer. */
  candles: PoolCandle[];
  /** The interval `candles` are for. While another interval loads, this still names the one on screen. */
  interval: ChartInterval | null;
  pool: DetailPool | null;
  /** Newest first. */
  swaps: PoolSwap[];
  state: "idle" | "loading" | "ready" | "missing" | "unavailable";
};

const IDLE: PoolDetailState = { candles: [], interval: null, pool: null, swaps: [], state: "idle" };

/**
 * One pool's indexed detail (`/api/pools/:id`): price candles for one
 * interval, the pool's market figures and its recent swaps. Refreshed on an
 * interval and shortly after a confirmed transaction. An empty `poolId` reads
 * nothing. A switched pool never shows the previous pool's data; a switched
 * interval keeps the same pool's last candles (state "loading") until the new
 * ones land, so the chart dims instead of blinking out.
 */
export function usePoolDetail(poolId: string, interval: ChartInterval, refreshMs = 15_000): PoolDetailState {
  const key = poolId ? `${poolId}|${interval}` : "";
  const [result, setResult] = useState<{ key: string; poolId: string; value: PoolDetailState }>({ key: "", poolId: "", value: IDLE });

  useEffect(() => {
    if (!key) return;
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/pools/${encodeURIComponent(poolId)}?interval=${interval}`, { cache: "no-store" });
        if (response.status === 404) throw new Error("missing");
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as { pool?: DetailPool; quote_candles?: PoolCandle[]; swaps?: PoolSwap[] };
        if (!active) return;
        // Curated symbols and decimals win over the indexed token record.
        setResult({ key, poolId, value: {
          candles: Array.isArray(data.quote_candles) ? data.quote_candles : [],
          interval,
          pool: data.pool ? withAssetOverrides(data.pool) : null,
          swaps: Array.isArray(data.swaps) ? data.swaps : [],
          state: "ready",
        } });
      } catch (error) {
        if (!active) return;
        const state = error instanceof Error && error.message === "missing" ? "missing" : "unavailable";
        // Keep data already on screen for this pool and interval when a refresh fails.
        setResult((current) => current.key === key && current.value.state === "ready" ? current : { key, poolId, value: { ...IDLE, state } });
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
  if (result.key === key) return result.value;
  return result.poolId === poolId && result.value.state === "ready" ? { ...result.value, state: "loading" } : { ...IDLE, state: "loading" };
}
