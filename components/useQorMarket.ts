"use client";

import { useEffect, useState } from "react";
import type { MarketRange, QorMarket } from "../lib/qor-price";

type MarketState = { data: QorMarket | null; status: "loading" | "ready" | "refreshing" | "unavailable" };

/**
 * Loads QOR/USD market data. A range change keeps the previous data on screen
 * until the new range arrives, so charts never flash empty.
 */
export function useQorMarket(range: MarketRange, refreshMs = 60_000) {
  const [state, setState] = useState<MarketState>({ data: null, status: "loading" });

  useEffect(() => {
    let active = true;
    async function load() {
      setState((current) => ({ data: current.data, status: current.data ? "refreshing" : "loading" }));
      try {
        const response = await fetch(`/api/market/qor?range=${range}`, { cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as QorMarket;
        if (active) setState({ data, status: "ready" });
      } catch {
        if (active) setState((current) => ({ data: current.data, status: current.data ? "ready" : "unavailable" }));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [range, refreshMs]);

  return state;
}
