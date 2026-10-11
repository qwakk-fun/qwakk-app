"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Clock3, Flame, Layers, LayoutGrid, List, Plus, Search, TrendingUp } from "lucide-react";
import { CreatePoolPanel } from "./CreatePoolPanel";
import { PoolCard } from "./PoolCard";
import { CREATE_EVENT, QwakkHeader, SEARCH_EVENT } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useFeatures } from "./useFeatures";
import { formatDecimal, formatPercentChange, marketChange, useMarkets, type Market } from "./useMarkets";
import { useQorMarket } from "./useQorMarket";
import { formatBaseAmount } from "../lib/qwakk-assets";
import { formatUsdPrice } from "../lib/qor-price";

type Sort = "trending" | "newest" | "moves";
type View = "grid" | "table";

const SORTS = [
  { value: "trending", label: "Trending", icon: Flame },
  { value: "newest", label: "Newest", icon: Clock3 },
  { value: "moves", label: "Biggest moves", icon: TrendingUp },
] as const;

const VIEW_KEY = "qwakk-pools-view";

function reserve(value: string, decimals: string | number, symbol: string) {
  return `${formatBaseAmount(value ?? "0", Number(decimals), 4)} ${symbol}`;
}

function sortMarkets(markets: Market[], sort: Sort) {
  const sorted = [...markets];
  if (sort === "trending") return sorted.sort((a, b) => (Number(b.transactions_24h) || 0) - (Number(a.transactions_24h) || 0));
  if (sort === "newest") return sorted.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  // Pools without a 24h change go last.
  return sorted.sort((a, b) => Math.abs(marketChange(b) ?? -1) - Math.abs(marketChange(a) ?? -1));
}

export function MarketsView() {
  const { markets, state } = useMarkets();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("trending");
  const [view, setView] = useState<View>("grid");

  useEffect(() => {
    // The top bar search links here with ?q= and filters in place while this page is open.
    const initial = new URLSearchParams(window.location.search).get("q") ?? "";
    const timer = window.setTimeout(() => {
      if (initial) setQuery(initial);
      try {
        if (window.localStorage.getItem(VIEW_KEY) === "table") setView("table");
      } catch {
        // Storage can be unavailable; the grid view is the default.
      }
    }, 0);
    const onSearch = (event: Event) => setQuery(String((event as CustomEvent<string>).detail ?? ""));
    window.addEventListener(SEARCH_EVENT, onSearch);
    return () => { window.clearTimeout(timer); window.removeEventListener(SEARCH_EVENT, onSearch); };
  }, []);

  function changeView(next: View) {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Not remembering the choice is fine.
    }
  }

  const { nativeActions } = useFeatures();
  const [walletAddress, setWalletAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [amm, setAmm] = useState<{ poolCreationFee: string | null; minLiquidity: string | null } | null>(null);

  // The rail and top bar "+" link here with ?create=1.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("create") === "1") setCreating(true);
    }, 0);
    const openCreate = () => setCreating(true);
    window.addEventListener(CREATE_EVENT, openCreate);
    return () => { window.clearTimeout(timer); window.removeEventListener(CREATE_EVENT, openCreate); };
  }, []);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qwakk-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qwakk:wallet-change", restoreWallet);
    return () => window.removeEventListener("qwakk:wallet-change", restoreWallet);
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
    const filtered = needle ? markets.filter((market) => `${market.token_a_symbol} ${market.token_b_symbol} ${market.token_a} ${market.token_b} #${market.id}`.toLowerCase().includes(needle)) : markets;
    return sortMarkets(filtered, sort);
  }, [markets, query, sort]);

  const emptyState = state === "loading"
    ? <div className="empty"><p>Reading pools from QoreChain Diana…</p></div>
    : state === "unavailable"
      ? <div className="empty"><h3>Pool data is temporarily unavailable</h3><p>The market indexer could not be reached. This page retries on its own.</p></div>
      : markets.length === 0
        ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>No pools are open yet</h3><p>The first native AMM pool on QoreChain Diana will show up here with its price, activity and chart.</p></div>
        : <div className="empty"><h3>No pools match “{query}”</h3><p>Try a token symbol such as QOR.</p></div>;

  return <div className="app-shell">
    <QwakkHeader page="pools" />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <span className="kicker">QoreChain Diana</span>
            <h1>Pools</h1>
            <p>Every native AMM pool on QoreChain Diana, with prices and activity read from the chain.</p>
          </div>
          <div className="page-head-actions">
            <label className="search search-inline"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token or pool" aria-label="Search pools" /></label>
            {nativeActions && (walletAddress
              ? <button type="button" className="btn btn-primary" aria-expanded={creating} onClick={() => setCreating((value) => !value)}><Plus size={16} />New pool</button>
              : <button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>)}
          </div>
        </section>

        {nativeActions && creating && walletAddress && <CreatePoolPanel walletAddress={walletAddress} amm={amm} />}

        <section className="stat-row" aria-label="Pool summary">
          <div className="stat-card stat"><span className="stat-label">Open pools</span><span className="stat-value num">{state === "ready" ? markets.length : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">Swaps in 24h</span><span className="stat-value num">{state === "ready" ? formatDecimal(swaps24h, 0) : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">QOR price (CoinGecko)</span><span className="stat-value num">{qor.data ? formatUsdPrice(qor.data.price) : "…"}</span></div>
        </section>

        <div className="toolbar">
          <div className="pill-tabs" role="group" aria-label="Sort pools">
            {SORTS.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => setSort(value)}><Icon size={14} />{label}</button>)}
          </div>
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><LayoutGrid size={14} />Grid</button>
            <button type="button" aria-pressed={view === "table"} onClick={() => changeView("table")}><List size={14} />Table</button>
          </div>
        </div>

        {visibleMarkets.length === 0
          ? <section className="panel" aria-label="QoreChain Diana pools">{emptyState}</section>
          : view === "grid"
            ? <section className="pool-grid" aria-label="QoreChain Diana pools">{visibleMarkets.map((market) => <PoolCard market={market} key={market.id} />)}</section>
            : <section className="panel markets-table" aria-label="QoreChain Diana pools">
              <div className="table">
                <div className="table-row table-head"><span>Pool</span><span className="num">Price</span><span className="num hide-sm">24h swaps</span><span className="num hide-sm">24h change</span><span className="num hide-sm">Reserves</span><span aria-hidden="true" /></div>
                {visibleMarkets.map((market) => {
                  const percentage = marketChange(market);
                  return <Link className="table-row" href={`/pools/${market.id}`} key={market.id}>
                    <span className="cell-main"><span className="pair-icons"><TokenIcon denom={market.token_a} size="regular" /><TokenIcon denom={market.token_b} size="regular" /></span><span><b>{market.token_a_symbol} / {market.token_b_symbol}</b><small>#{market.id} · {market.pool_type.replace(/_/g, " ")}</small></span></span>
                    <span className="num"><b>{market.price_b_per_a === null ? "No trades yet" : formatDecimal(market.price_b_per_a)}</b><span className="cell-sub">{market.token_b_symbol} per {market.token_a_symbol}</span></span>
                    <span className="num hide-sm"><b>{formatDecimal(market.transactions_24h, 0)}</b><span className="cell-sub">{market.volume_qor_24h === null ? "Volume not in QOR" : `${formatDecimal(market.volume_qor_24h, 4)} QOR`}</span></span>
                    <span className={`num hide-sm change-cell ${percentage === null ? "subtle" : percentage >= 0 ? "up" : "down"}`}>{formatPercentChange(percentage)}</span>
                    <span className="num hide-sm"><b>{reserve(market.reserve_a, market.token_a_decimals, market.token_a_symbol)}</b><span className="cell-sub">{reserve(market.reserve_b, market.token_b_decimals, market.token_b_symbol)}</span></span>
                    <ChevronRight size={16} className="subtle" aria-hidden="true" />
                  </Link>;
                })}
              </div>
            </section>}
      </div>
    </main>
    <SiteFooter />
  </div>;
}
