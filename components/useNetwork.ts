"use client";

import { useEffect, useState } from "react";

export type NetworkSummary = { height: string | null; pools: number } | null;

/** Latest QoreChain Diana block height and pool count. Keeps the last values when the chain is unreachable. */
export function useNetwork(refreshMs = 10_000) {
  const [network, setNetwork] = useState<NetworkSummary>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/network", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { height?: string | null; pools?: unknown[] };
        if (active) setNetwork({ height: data.height ?? null, pools: Array.isArray(data.pools) ? data.pools.length : 0 });
      } catch {
        // Keep the previous values.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { active = false; window.clearInterval(timer); };
  }, [refreshMs]);
  return network;
}

export function formatBlockHeight(height: string | null | undefined) {
  return height ? new Intl.NumberFormat("en-US").format(Number(height)) : "Not available";
}
