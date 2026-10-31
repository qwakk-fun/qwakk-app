"use client";

import { useEffect, useState } from "react";
import { withAssetOverrides } from "../lib/qwakk-assets";
import type { QuoteMarket } from "../lib/qwakk-market-view";

export type Market = QuoteMarket & {
  id: string | number;
  pool_type: string;
  status: string;
  token_a_symbol: string;
  token_b_symbol: string;
  /** Null when the indexer does not know the token's decimals. */
  token_a_decimals: string | number | null;
  token_b_decimals: string | number | null;
  reserve_a: string;
  reserve_b: string;
  transactions_24h: string | number;
  volume_qor_24h: string | number | null;
  decimals_known?: boolean | null;
};

export type MarketsState = { markets: Market[]; state: "loading" | "ready" | "unavailable" };

/** Prices, change and volume are read in quote per base (lib/qwakk-market-view.ts). */
export { marketChange } from "../lib/qwakk-market-view";

export function formatDecimal(value: string | number | null | undefined, digits = 6) {
  const number = Number(value);
  if (value === null || value === undefined || !Number.isFinite(number)) return "Not available";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(number);
}

export function formatPercentChange(value: number | null) {
  if (value === null) return "Not available";
  return `${value >= 0 ? "▲" : "▼"} ${formatDecimal(Math.abs(value), 2)}%`;
}

/** Indexed native AMM pools on the configured network, refreshed on an interval and after confirmed actions. */
export function useMarkets(refreshMs = 15_000): MarketsState {
  const [result, setResult] = useState<MarketsState>({ markets: [], state: "loading" });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        if (!response.ok) throw new Error("Market data unavailable");
        const data = await response.json() as { markets?: Market[] };
        // Curated symbols and decimals win over the indexed token record.
        if (active) setResult({ markets: Array.isArray(data.markets) ? data.markets.map(withAssetOverrides) : [], state: "ready" });
      } catch {
        if (active) setResult((current) => current.state === "ready" ? current : { markets: [], state: "unavailable" });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    // The indexer polls the chain every few seconds, so read again shortly after a confirmed action.
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qwakk:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qwakk:tx-confirmed", reloadSoon); };
  }, [refreshMs]);

  return result;
}
