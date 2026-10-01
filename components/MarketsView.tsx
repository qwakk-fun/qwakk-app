"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Layers, Plus, Search } from "lucide-react";
import { CreatePoolPanel } from "./CreatePoolPanel";
import { QoraHeader } from "./QoraHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useFeatures } from "./useFeatures";
import { useQorMarket } from "./useQorMarket";
import { formatBaseAmount } from "../lib/qora-assets";
import { formatUsdPrice } from "../lib/qor-price";

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
    // The indexer polls the chain every few seconds, so read again shortly after a confirmed action.
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qora:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qora:tx-confirmed", reloadSoon); };
  }, []);

  const { nativeActions } = useFeatures();
  const [walletAddress, setWalletAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [amm, setAmm] = useState<{ poolCreationFee: string | null; minLiquidity: string | null } | null>(null);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qora-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qora:wallet-change", restoreWallet);
    return () => window.removeEventListener("qora:wallet-change", restoreWallet);
  }, []);

  useEffect(() => {
    if (!nativeActions) return;
    fetch("/api/network", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ amm?: { poolCreationFee: string | null; minLiquidity: string | null } | null }> : null)
      .then((data) => setAmm(data?.amm ?? null))
      .catch(() => undefined);
  }, [nativeActions]);

  const qor = useQorMarket("1");
  const swaps24h = markets.reduce((total, market) => total + (Number(market.transactions_24h) || 0), 0);

  const visibleMarkets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return markets;
    return markets.filter((market) => `${market.token_a_symbol} ${market.token_b_symbol} ${market.token_a} ${market.token_b}`.toLowerCase().includes(needle));
  }, [markets, query]);

  return <div className="app-shell">
    <QoraHeader page="pools" />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <h1>Pools</h1>
            <p>Every native AMM pool on QoreChain Diana, with prices and activity read from the chain.</p>
          </div>
          <div className="page-head-actions">
            <label className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token or pool" aria-label="Search pools" /></label>
            {nativeActions && (walletAddress
              ? <button type="button" className="btn btn-primary" aria-expanded={creating} onClick={() => setCreating((value) => !value)}><Plus size={16} />New pool</button>
              : <button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new Event("qora:request-connect"))}>Connect wallet</button>)}
          </div>
        </section>

        {nativeActions && creating && walletAddress && <CreatePoolPanel walletAddress={walletAddress} amm={amm} />}

        <section className="stat-row" aria-label="Pool summary">
          <div className="stat-card stat"><span className="stat-label">Open pools</span><span className="stat-value num">{state === "ready" ? markets.length : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">Swaps in 24h</span><span className="stat-value num">{state === "ready" ? decimal(swaps24h, 0) : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">QOR price (CoinGecko)</span><span className="stat-value">{qor.data ? formatUsdPrice(qor.data.price) : "…"}</span></div>
        </section>

        <section className="panel markets-table" aria-label="QoreChain Diana pools" style={{ marginTop: 16 }}>
          <div className="table">
            <div className="table-row table-head"><span>Pool</span><span className="num">Price</span><span className="num hide-sm">24h swaps</span><span className="num hide-sm">24h change</span><span className="num hide-sm">Reserves</span><span aria-hidden="true" /></div>
            {state === "loading" && <div className="empty"><p>Reading pools from QoreChain Diana…</p></div>}
            {state === "unavailable" && <div className="empty"><h3>Pool data is temporarily unavailable</h3><p>The market indexer could not be reached. This page retries on its own.</p></div>}
            {state === "ready" && visibleMarkets.length === 0 && (markets.length === 0
              ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>No pools are open yet</h3><p>The first native AMM pool on QoreChain Diana will show up here with its price, activity and chart.</p></div>
              : <div className="empty"><h3>No pools match your search</h3><p>Try a token symbol such as QOR.</p></div>)}
            {visibleMarkets.map((market) => {
              const percentage = change(market);
              return <Link className="table-row" href={`/pools/${market.id}`} key={market.id}>
                <span className="cell-main"><span className="pair-icons"><TokenIcon denom={market.token_a} size="regular" /><TokenIcon denom={market.token_b} size="regular" /></span><span><b>{market.token_a_symbol} / {market.token_b_symbol}</b><small>#{market.id} · {market.pool_type.replace(/_/g, " ")}</small></span></span>
                <span className="num"><b>{market.price_b_per_a === null ? "No trades yet" : decimal(market.price_b_per_a)}</b><span className="cell-sub">{market.token_b_symbol} per {market.token_a_symbol}</span></span>
                <span className="num hide-sm"><b>{decimal(market.transactions_24h, 0)}</b><span className="cell-sub">{market.volume_qor_24h === null ? "Volume not in QOR" : `${decimal(market.volume_qor_24h, 4)} QOR`}</span></span>
                <span className={`num hide-sm change-cell ${percentage === null ? "subtle" : percentage >= 0 ? "up" : "down"}`}>{percentage === null ? "Not available" : `${percentage >= 0 ? "▲" : "▼"} ${decimal(Math.abs(percentage), 2)}%`}</span>
                <span className="num hide-sm"><b>{reserve(market.reserve_a, market.token_a_decimals, market.token_a_symbol)}</b><span className="cell-sub">{reserve(market.reserve_b, market.token_b_decimals, market.token_b_symbol)}</span></span>
                <ChevronRight size={16} className="subtle" aria-hidden="true" />
              </Link>;
            })}
          </div>
        </section>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
