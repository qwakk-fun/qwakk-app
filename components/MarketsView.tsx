"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Search } from "lucide-react";
import { QoraHeader } from "./QoraHeader";
import { TokenIcon } from "./TokenIcon";
import { formatBaseAmount } from "../lib/qora-assets";

type Market = {
  id: string | number;
  pool_type: string;
  status: string;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: string | number;
  token_b_decimals: string | number;
  reserve_a: string;
  reserve_b: string;
  transactions_24h: string | number;
  volume_qor_24h: string | number | null;
  price_b_per_a: string | number | null;
  price_24h_ago: string | number | null;
};

function decimal(value: string | number | null | undefined, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Not available";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(number);
}

function reserve(value: string, decimals: string | number, symbol: string) {
  return `${formatBaseAmount(value ?? "0", Number(decimals), 4)} ${symbol}`;
}

function change(market: Market) {
  const current = Number(market.price_b_per_a);
  const previous = Number(market.price_24h_ago);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function MarketsView() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/markets", { cache: "no-store" });
        if (!response.ok) throw new Error("Market data unavailable");
        const data = await response.json() as { markets?: Market[] };
        if (active) {
          setMarkets(Array.isArray(data.markets) ? data.markets : []);
          setState("ready");
        }
      } catch {
        if (active) setState("unavailable");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const visibleMarkets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return markets;
    return markets.filter((market) => `${market.token_a_symbol} ${market.token_b_symbol} ${market.token_a} ${market.token_b}`.toLowerCase().includes(needle));
  }, [markets, query]);

  return <main className="market-shell">
    <QoraHeader page="pools" />
    <section className="market-topbar">
      <div>
        <p className="eyebrow">QORECHAIN MARKETS</p>
        <h1>Explore every pool.</h1>
        <p>Live markets, pricing and on-chain activity in one focused view.</p>
      </div>
      <label className="market-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token or pool" aria-label="Search markets" /></label>
    </section>

    <section className="market-toolbar" aria-label="Market data source">
      <span className="market-source"><i />On-chain data</span>
      <span className="market-source">{markets.length} {markets.length === 1 ? "pool" : "pools"}</span>
    </section>

    <section className="market-table-wrap" aria-label="QoreChain markets">
      <div className="market-table">
        <div className="market-row market-head"><span>Market</span><span>Price</span><span>24h activity</span><span>24h change</span><span>Pool reserves</span><span aria-hidden="true" /></div>
        {state === "loading" && <div className="terminal-empty">Reading current pool data.</div>}
        {state === "unavailable" && <div className="terminal-empty"><span className="status-dot" />Market data is temporarily unavailable. Please refresh shortly.</div>}
        {state === "ready" && visibleMarkets.length === 0 && <div className="terminal-empty"><span className="status-dot" />{markets.length === 0 ? "There are no active QoreChain pools yet." : "No markets match your search."}</div>}
        {visibleMarkets.map((market) => {
          const percentage = change(market);
          return <Link className="market-row market-data" href={`/pools/${market.id}`} key={market.id}>
            <span className="market-pair"><span className="pair-icons"><TokenIcon denom={market.token_a} size="regular" /><TokenIcon denom={market.token_b} size="regular" /></span><span><b>{market.token_a_symbol} / {market.token_b_symbol}</b><small>Pool #{market.id} · {market.pool_type.replace(/_/g, " ")}</small></span></span>
            <span><b>{market.price_b_per_a === null ? "No trades yet" : `${decimal(market.price_b_per_a)} ${market.token_b_symbol}`}</b><small>per {market.token_a_symbol}</small></span>
            <span><b>{decimal(market.transactions_24h, 0)} swaps</b><small>{market.volume_qor_24h === null ? "Volume not priced in QOR" : `${decimal(market.volume_qor_24h, 4)} QOR`}</small></span>
            <span className={percentage === null ? "market-neutral" : percentage >= 0 ? "market-positive" : "market-negative"}>{percentage === null ? "Not available" : `${percentage >= 0 ? "+" : ""}${decimal(percentage, 2)}%`}</span>
            <span className="reserve-cell"><b>{reserve(market.reserve_a, market.token_a_decimals, market.token_a_symbol)}</b><small>{reserve(market.reserve_b, market.token_b_decimals, market.token_b_symbol)}</small></span>
            <ArrowUpRight size={18} aria-hidden="true" />
          </Link>;
        })}
      </div>
    </section>
  </main>;
}
