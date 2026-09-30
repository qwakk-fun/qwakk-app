"use client";

import { useEffect, useState } from "react";
import { formatChange, formatUsdCompact, formatUsdPrice } from "../lib/qor-price";
import { Sparkline } from "./Sparkline";
import { TokenIcon } from "./TokenIcon";
import { useQorMarket } from "./useQorMarket";

type NetworkState = { height: string | null; pools: number } | null;

function useNetwork() {
  const [network, setNetwork] = useState<NetworkState>(null);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/network", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { height?: string | null; pools?: unknown[] };
        if (active) setNetwork({ height: data.height ?? null, pools: Array.isArray(data.pools) ? data.pools.length : 0 });
      } catch {
        // The strip keeps its previous values when QoreChain Diana cannot be reached.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return network;
}

/** Live QOR market card for the landing hero. */
export function TickerCard() {
  const { data, status } = useQorMarket("7");
  const change = data?.change24h ?? null;

  return <aside className="panel ticker-card" aria-label="QOR market">
    <div className="ticker-head">
      <span className="ticker-pair"><TokenIcon denom="uqor" size="regular" />QOR <span className="subtle">/ USD</span></span>
      <span className="kicker"><span className={`dot ${data ? "live" : ""}`} /> 7D</span>
    </div>
    <div className="ticker-price">
      <strong>{data ? formatUsdPrice(data.price) : status === "unavailable" ? "Not available" : "Loading…"}</strong>
      {data && <span className={`change-cell ${change !== null && change < 0 ? "down" : "up"}`}>{formatChange(change)}</span>}
    </div>
    <Sparkline points={data?.points ?? []} height={72} />
    <div className="ticker-stats">
      <div className="stat"><span className="stat-label">24h volume</span><span className="stat-value">{formatUsdCompact(data?.volume24h ?? null)}</span></div>
      <div className="stat"><span className="stat-label">Market cap</span><span className="stat-value">{formatUsdCompact(data?.marketCap ?? null)}</span></div>
    </div>
    <p className="ticker-source">QOR market across exchanges, from CoinGecko.</p>
  </aside>;
}

/** Real network numbers under the hero. */
export function StatsStrip() {
  const network = useNetwork();
  const { data } = useQorMarket("1");
  const height = network?.height ? new Intl.NumberFormat("en-US").format(Number(network.height)) : "Not available";

  return <section className="stats-strip" aria-label="Network at a glance">
    <div><span className="stat-label">QoreChain Diana block</span><strong className="num">{network ? height : "…"}</strong></div>
    <div><span className="stat-label">Native AMM pools</span><strong className="num">{network ? network.pools : "…"}</strong></div>
    <div><span className="stat-label">QOR price</span><strong>{data ? formatUsdPrice(data.price) : "…"}</strong></div>
    <div><span className="stat-label">QOR market cap</span><strong>{data ? formatUsdCompact(data.marketCap) : "…"}</strong></div>
  </section>;
}
