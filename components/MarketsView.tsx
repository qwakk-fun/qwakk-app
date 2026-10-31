"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Clock3, Flame, Layers, LayoutGrid, List, Plus, Search, TrendingUp, X } from "lucide-react";
import { CreatePoolPanel } from "./CreatePoolPanel";
import { PoolCard } from "./PoolCard";
import { CREATE_EVENT, QwakkHeader, SEARCH_EVENT } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useNetworkCopy } from "./NetworkContext";
import { useFeatures } from "./useFeatures";
import { formatDecimal, formatPercentChange, marketChange, useMarkets, type Market } from "./useMarkets";
import { useQorMarket } from "./useQorMarket";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketReserves, marketSides, marketVolume, pairLabel, priceUnit } from "../lib/qwakk-market-view";
import { formatUsdPrice } from "../lib/qor-price";

type Sort = "trending" | "newest" | "moves";
type View = "grid" | "table";

const SORTS = [
  { value: "trending", label: "Trending", icon: Flame },
  { value: "newest", label: "Newest", icon: Clock3 },
  { value: "moves", label: "Biggest moves", icon: TrendingUp },
] as const;

const VIEW_KEY = "qwakk-pools-view";

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
  // Pools flagged by the indexer as low liquidity (dust or empty reserves) stay out of the default list.
  const [showLowLiquidity, setShowLowLiquidity] = useState(false);
  const { copy } = useNetworkCopy();

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

  // Each wallet action has its own switch (QWAKK_NATIVE_ACTIONS).
  const nativeActions = useFeatures().actions.create_pool;
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

  // Create pool opens in a modal <dialog>: showModal() makes the page behind it
  // inert (focus stays inside) and gives Esc. The form stays mounted while a
  // check or a QoreX approval runs, and the dialog cannot close until it ends.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const createBusyRef = useRef(false);
  const [createBusy, setCreateBusy] = useState(false);
  const dialogOpen = nativeActions && creating && Boolean(walletAddress);

  useEffect(() => { createBusyRef.current = createBusy; }, [createBusy]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) {
      const active = document.activeElement;
      triggerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
    } else if (!dialogOpen && dialog.open) {
      dialog.close();
    }
  }, [dialogOpen]);

  const closeCreate = useCallback(() => {
    if (createBusyRef.current) return;
    setCreating(false);
    // Closing drops ?create=1, so a reload or a shared link does not reopen the form.
    const url = new URL(window.location.href);
    if (url.searchParams.has("create")) {
      url.searchParams.delete("create");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const trigger = triggerRef.current;
    window.setTimeout(() => (trigger?.isConnected ? trigger : document.querySelector<HTMLElement>("[data-create-trigger]"))?.focus(), 0);
  }, []);

  // Backdrop click closes. The dialog box has no padding, so a click whose
  // target is the <dialog> itself landed on the backdrop. Keyboard users close
  // with Esc or the close button; this listener is pointer only.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClick = (event: MouseEvent) => { if (event.target === dialog) closeCreate(); };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, [closeCreate, nativeActions, walletAddress]);

  useEffect(() => {
    if (!nativeActions) return;
    fetch("/api/network", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ amm?: { poolCreationFee: string | null; minLiquidity: string | null } | null }> : null)
      .then((data) => setAmm(data?.amm ?? null))
      .catch(() => undefined);
  }, [nativeActions]);

  const qor = useQorMarket("1");
  const swaps24h = markets.reduce((total, market) => total + (Number(market.transactions_24h) || 0), 0);

  const lowLiquidityCount = markets.filter(isLowLiquidity).length;
  const visibleMarkets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const listed = showLowLiquidity ? markets : markets.filter((market) => !isLowLiquidity(market));
    const filtered = needle ? listed.filter((market) => `${market.token_a_symbol} ${market.token_b_symbol} ${market.token_a} ${market.token_b} #${market.id}`.toLowerCase().includes(needle)) : listed;
    return sortMarkets(filtered, sort);
  }, [markets, query, sort, showLowLiquidity]);

  const emptyState = state === "loading"
    ? <div className="empty"><p>{copy("Reading pools from QoreChain Diana…")}</p></div>
    : state === "unavailable"
      ? <div className="empty"><h3>Pool data is temporarily unavailable</h3><p>The market indexer could not be reached. This page retries on its own.</p></div>
      : markets.length === 0
        ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>No pools are open yet</h3><p>{copy("The first native AMM pool on QoreChain Diana will show up here with its price, activity and chart.")}</p></div>
        : !showLowLiquidity && !query.trim() && lowLiquidityCount === markets.length
          ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>Only low-liquidity pools are open</h3><p>{lowLiquidityCount === 1 ? "One pool is open, but it holds too little to give a reliable price." : `${lowLiquidityCount} pools are open, but each holds too little to give a reliable price.`}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLowLiquidity(true)}>Show low-liquidity pools</button></div>
          : <div className="empty"><h3>No pools match “{query}”</h3><p>{!showLowLiquidity && lowLiquidityCount > 0 ? "Try a token symbol such as QOR, or include low-liquidity pools." : "Try a token symbol such as QOR."}</p></div>;

  return <div className="app-shell">
    <QwakkHeader page="pools" />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <span className="kicker">{copy("QoreChain Diana")}</span>
            <h1>Pools</h1>
            <p>{copy("Every native AMM pool on QoreChain Diana, with prices and activity read from the chain.")}</p>
          </div>
          <div className="page-head-actions">
            <label className="search search-inline"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search token or pool" aria-label="Search pools" /></label>
            {nativeActions && (walletAddress
              ? <button type="button" className="btn btn-primary" aria-haspopup="dialog" data-create-trigger onClick={() => setCreating(true)}><Plus size={16} />New pool</button>
              : <button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>)}
          </div>
        </section>

        {nativeActions && walletAddress && <dialog
          ref={dialogRef}
          className="sheet-dialog"
          aria-labelledby="create-dialog-title"
          // Esc: close unless a transaction is in flight.
          onCancel={(event) => { event.preventDefault(); closeCreate(); }}
          // A close that slipped past cancel (a repeated Esc) reopens while busy, so the form is never hidden mid-approval.
          onClose={() => { if (createBusyRef.current) dialogRef.current?.showModal(); else if (creating) closeCreate(); }}
        >
          <div className="sheet-dialog-body">
            <div className="sheet-dialog-head">
              <h2 id="create-dialog-title">New pool</h2>
              <button type="button" className="icon-btn" onClick={closeCreate} disabled={createBusy} aria-label="Close" title={createBusy ? "Finish or cancel in QoreX first" : "Close"}><X size={16} /></button>
            </div>
            {creating && <CreatePoolPanel walletAddress={walletAddress} amm={amm} markets={markets} onBusyChange={setCreateBusy} />}
          </div>
        </dialog>}

        <section className="stat-row" aria-label="Pool summary">
          <div className="stat-card stat"><span className="stat-label">Open pools</span><span className="stat-value num">{state === "ready" ? markets.length : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">Swaps in 24h</span><span className="stat-value num">{state === "ready" ? formatDecimal(swaps24h, 0) : "…"}</span></div>
          <div className="stat-card stat"><span className="stat-label">QOR price (CoinGecko)</span><span className="stat-value num">{qor.data ? formatUsdPrice(qor.data.price) : "…"}</span></div>
        </section>

        <div className="toolbar">
          <div className="pill-tabs" role="group" aria-label="Sort pools">
            {SORTS.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => setSort(value)}><Icon size={14} />{label}</button>)}
          </div>
          <div className="toolbar-end">
          {lowLiquidityCount > 0 && <label className="check-toggle"><input type="checkbox" checked={showLowLiquidity} onChange={(event) => setShowLowLiquidity(event.target.checked)} />Show low-liquidity pools ({lowLiquidityCount})</label>}
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><LayoutGrid size={14} />Grid</button>
            <button type="button" aria-pressed={view === "table"} onClick={() => changeView("table")}><List size={14} />Table</button>
          </div>
          </div>
        </div>

        {visibleMarkets.length === 0
          ? <section className="panel" aria-label={copy("QoreChain Diana pools")}>{emptyState}</section>
          : view === "grid"
            ? <section className="pool-grid" aria-label={copy("QoreChain Diana pools")}>{visibleMarkets.map((market) => <PoolCard market={market} key={market.id} />)}</section>
            : <section className="panel markets-table" aria-label={copy("QoreChain Diana pools")}>
              <div className="table">
                <div className="table-row table-head"><span>Pool</span><span className="num">Price</span><span className="num hide-sm">24h swaps</span><span className="num hide-sm">24h change</span><span className="num hide-sm">Reserves</span><span aria-hidden="true" /></div>
                {visibleMarkets.map((market) => {
                  const lowLiquidity = isLowLiquidity(market);
                  const percentage = lowLiquidity ? null : marketChange(market);
                  const price = lowLiquidity ? null : marketPrice(market);
                  const { base, quote } = marketSides(market);
                  const volume = marketVolume(market);
                  const reserves = marketReserves(market);
                  return <Link className="table-row" href={`/pools/${market.id}`} key={market.id}>
                    <span className="cell-main"><span className="pair-icons"><TokenIcon denom={base.denom} size="regular" /><TokenIcon denom={quote.denom} size="regular" /></span><span><b>{pairLabel(market, " / ")}</b><small>#{market.id} · {market.pool_type.replace(/_/g, " ")}{lowLiquidity && <span className="low-tag">Low liquidity</span>}</small></span></span>
                    <span className="num"><b>{lowLiquidity ? "Not shown" : price === null ? "No trades yet" : formatQuotePrice(price)}</b><span className="cell-sub">{priceUnit(market)}</span></span>
                    <span className="num hide-sm"><b>{formatDecimal(market.transactions_24h, 0)}</b><span className="cell-sub">{volume.value === null ? "No 24h volume" : `${formatDecimal(volume.value, 4)} ${volume.symbol}`}</span></span>
                    <span className={`num hide-sm change-cell ${percentage === null ? "subtle" : percentage >= 0 ? "up" : "down"}`}>{formatPercentChange(percentage)}</span>
                    <span className="num hide-sm"><b>{reserves.base}</b><span className="cell-sub">{reserves.quote}</span></span>
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
