"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Clock3, Flame, Layers, LayoutGrid, List, Plus, Search, Star, TrendingUp, X } from "lucide-react";
import { CreatePoolPanel } from "./CreatePoolPanel";
import { FavoriteButton } from "./FavoriteButton";
import { FavoritesList } from "./FavoritesList";
import { PoolCard } from "./PoolCard";
import { CREATE_EVENT, QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useNetworkCopy } from "./NetworkContext";
import { useFavorites } from "./useFavorites";
import { useFeatures } from "./useFeatures";
import { formatDecimal, formatPercentChange, marketChange, useMarkets, type Market } from "./useMarkets";
import { useQorMarket } from "./useQorMarket";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketReserves, marketSearchEntry, marketSides, marketVolume, pairLabel, priceUnit } from "../lib/qwakk-market-view";
import { formatUsdPrice } from "../lib/qor-price";
import { BRAND } from "../lib/brand";
import { searchEmptyCopy, searchPools, shortQuery } from "../lib/qwakk-search";
import { marketPairSlugs, poolPath } from "../lib/qwakk-pair-slug";

type Sort = "trending" | "newest" | "moves";
type View = "grid" | "table";
type Scope = "all" | "favorites";

const SORTS = [
  { value: "trending", label: "Trending", icon: Flame },
  { value: "newest", label: "Newest", icon: Clock3 },
  { value: "moves", label: "Biggest moves", icon: TrendingUp },
] as const;

const VIEW_KEY = "qwakk-pools-view";
const SCOPE_KEY = "qwakk-pools-scope";

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
  // All pools, or only the ones starred in this browser.
  const [scope, setScope] = useState<Scope>("all");
  const favorites = useFavorites();
  // Pools flagged by the indexer as low liquidity (dust or empty reserves) stay out of the default list.
  const [showLowLiquidity, setShowLowLiquidity] = useState(false);
  const { copy } = useNetworkCopy();

  useEffect(() => {
    // A link with ?q= (or ?view=favorites) opens the list already filtered.
    const params = new URLSearchParams(window.location.search);
    const initial = params.get("q") ?? "";
    const timer = window.setTimeout(() => {
      if (initial) setQuery(initial);
      try {
        if (window.localStorage.getItem(VIEW_KEY) === "table") setView("table");
        if (params.get("view") === "favorites" || window.localStorage.getItem(SCOPE_KEY) === "favorites") setScope("favorites");
      } catch {
        // Storage can be unavailable; the grid view of all pools is the default.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function remember(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not remembering the choice is fine.
    }
  }

  function changeView(next: View) {
    setView(next);
    remember(VIEW_KEY, next);
  }

  function changeScope(next: Scope) {
    setScope(next);
    remember(SCOPE_KEY, next);
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
  // Readable pool links (/pools/qwakk-qor), made from every indexed pool so a shared pair opens the right one.
  const slugs = useMemo(() => marketPairSlugs(markets), [markets]);
  // Same matcher as the search dialog and the swap picker (lib/qwakk-search.ts); the chosen sort still orders the list.
  const visibleMarkets = useMemo(() => {
    const listed = showLowLiquidity ? markets : markets.filter((market) => !isLowLiquidity(market));
    const filtered = query.trim() ? searchPools(listed, query, marketSearchEntry).map((match) => match.item) : listed;
    return sortMarkets(filtered, sort);
  }, [markets, query, sort, showLowLiquidity]);
  // Favorites keep their starred order and include low-liquidity pools: the visitor picked them.
  const favoriteIds = useMemo(() => {
    if (!query.trim()) return favorites.ids;
    const matched = new Set(searchPools(markets, query, marketSearchEntry).map((match) => String(match.item.id)));
    return favorites.ids.filter((id) => matched.has(id));
  }, [favorites.ids, markets, query]);
  const noMatch = searchEmptyCopy(query, BRAND.name);
  // A search that only finds hidden low-liquidity pools says so, instead of claiming the token is not listed.
  const hiddenMatches = query.trim() && !showLowLiquidity ? searchPools(markets.filter(isLowLiquidity), query, marketSearchEntry).length : 0;

  const emptyState = state === "loading"
    ? <div className="empty"><p>{copy("Reading pools from QoreChain Diana…")}</p></div>
    : state === "unavailable"
      ? <div className="empty"><h3>Pool data is temporarily unavailable</h3><p>The market indexer could not be reached. This page retries on its own.</p></div>
      : markets.length === 0
        ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>No pools are open yet</h3><p>{copy("The first native AMM pool on QoreChain Diana will show up here with its price, activity and chart.")}</p></div>
        : !showLowLiquidity && !query.trim() && lowLiquidityCount === markets.length
          ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>Only low-liquidity pools are open</h3><p>{lowLiquidityCount === 1 ? "One pool is open, but it holds too little to give a reliable price." : `${lowLiquidityCount} pools are open, but each holds too little to give a reliable price.`}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLowLiquidity(true)}>Show low-liquidity pools</button></div>
          : hiddenMatches > 0
            ? <div className="empty"><span className="empty-icon"><Layers size={18} /></span><h3>Only low-liquidity pools match</h3><p>{hiddenMatches === 1 ? "One pool matches, but it holds too little to give a reliable price." : `${hiddenMatches} pools match, but each holds too little to give a reliable price.`}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLowLiquidity(true)}>Show low-liquidity pools</button></div>
            : <div className="empty"><span className="empty-icon"><Search size={18} /></span><h3>{noMatch.title}</h3><p>{noMatch.body}</p></div>;

  const favoritesEmpty = favorites.ids.length === 0
    ? <div className="empty"><span className="empty-icon"><Star size={18} /></span><h3>No favorites yet</h3><p>Tap the star on any pool and it lands here with its price, 24h move and trend line. Stars stay in this browser, no wallet needed.</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => changeScope("all")}>Browse pools</button></div>
    : <div className="empty"><span className="empty-icon"><Search size={18} /></span><h3>No favorites match “{shortQuery(query)}”</h3><p>Clear the search to see every pool you starred.</p></div>;

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
            <label className="search search-inline"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Token, pool # or address" aria-label="Filter pools by token name, symbol, pool number or contract address" autoComplete="off" spellCheck={false} /></label>
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
          <div className="toolbar-start">
            <div className="segmented scope-tabs" role="group" aria-label="Show">
              <button type="button" aria-pressed={scope === "all"} onClick={() => changeScope("all")}><Layers size={14} aria-hidden="true" />All pools</button>
              <button type="button" aria-pressed={scope === "favorites"} onClick={() => changeScope("favorites")}><Star size={14} aria-hidden="true" />Favorites{favorites.ids.length > 0 && <span className="scope-count num">{favorites.ids.length}</span>}</button>
            </div>
            {scope === "all" && <div className="pill-tabs" role="group" aria-label="Sort pools">
              {SORTS.map(({ value, label, icon: Icon }) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => setSort(value)}><Icon size={14} />{label}</button>)}
            </div>}
          </div>
          {scope === "all" && <div className="toolbar-end">
          {lowLiquidityCount > 0 && <label className="check-toggle"><input type="checkbox" checked={showLowLiquidity} onChange={(event) => setShowLowLiquidity(event.target.checked)} />Show low-liquidity pools ({lowLiquidityCount})</label>}
          <div className="segmented" role="group" aria-label="Layout">
            <button type="button" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><LayoutGrid size={14} />Grid</button>
            <button type="button" aria-pressed={view === "table"} onClick={() => changeView("table")}><List size={14} />Table</button>
          </div>
          </div>}
        </div>

        {scope === "favorites"
          ? state === "unavailable" && favorites.ids.length > 0
            ? <section className="panel" aria-label="Favorite pools">{emptyState}</section>
            : favoriteIds.length > 0
              ? <FavoritesList ids={favoriteIds} markets={markets} favorites={favorites} ready={state === "ready"} label="Favorite pools" />
              : <section className="panel" aria-label="Favorite pools">{favorites.ready ? favoritesEmpty : favorites.failed ? <div className="empty"><h3>Favorites could not load</h3><p>Refresh the page to try again.</p></div> : <div className="empty"><p>Reading your favorites…</p></div>}</section>
        : visibleMarkets.length === 0
          ? state === "loading" && view === "grid"
            // Card-sized placeholders, so the grid does not jump when the pools arrive.
            ? <section className="pool-grid" aria-busy="true" aria-label={copy("QoreChain Diana pools")}><p className="sr-only">{copy("Reading pools from QoreChain Diana…")}</p>{Array.from({ length: 6 }, (_, index) => <span className="row-skeleton is-card" aria-hidden="true" key={index} />)}</section>
            : <section className="panel" aria-label={copy("QoreChain Diana pools")}>{emptyState}</section>
          : view === "grid"
            ? <section className="pool-grid" aria-label={copy("QoreChain Diana pools")}>{visibleMarkets.map((market) => <PoolCard market={market} favorites={favorites} href={poolPath(market.id, slugs)} key={market.id} />)}</section>
            : <section className="panel markets-table" aria-label={copy("QoreChain Diana pools")}>
              <div className="table">
                <div className="table-row table-head"><span>Pool</span><span className="num">Price</span><span className="num hide-sm">24h swaps</span><span className="num hide-sm">24h change</span><span className="num hide-sm">Reserves</span><span className="sr-only">Favorite</span></div>
                {visibleMarkets.map((market) => {
                  const lowLiquidity = isLowLiquidity(market);
                  const percentage = lowLiquidity ? null : marketChange(market);
                  const price = lowLiquidity ? null : marketPrice(market);
                  const { base, quote } = marketSides(market);
                  const volume = marketVolume(market);
                  const reserves = marketReserves(market);
                  // The pool name is the link and stretches over the row; the star sits above it, outside the link.
                  return <div className="table-row market-row" key={market.id}>
                    <span className="cell-main"><span className="pair-icons"><TokenIcon denom={base.denom} size="regular" /><TokenIcon denom={quote.denom} size="regular" /></span><span><Link className="row-link" href={poolPath(market.id, slugs)}><b>{pairLabel(market, " / ")}</b></Link><small>#{market.id} · {market.pool_type.replace(/_/g, " ")}{lowLiquidity && <span className="low-tag">Low liquidity</span>}</small></span></span>
                    <span className="num"><b>{lowLiquidity ? "Not shown" : price === null ? "No trades yet" : formatQuotePrice(price)}</b><span className="cell-sub">{priceUnit(market)}</span></span>
                    <span className="num hide-sm"><b>{formatDecimal(market.transactions_24h, 0)}</b><span className="cell-sub">{volume.value === null ? "No 24h volume" : `${formatDecimal(volume.value, 4)} ${volume.symbol}`}</span></span>
                    <span className={`num hide-sm change-cell ${percentage === null ? "subtle" : percentage >= 0 ? "up" : "down"}`}>{formatPercentChange(percentage)}</span>
                    <span className="num hide-sm"><b>{reserves.base}</b><span className="cell-sub">{reserves.quote}</span></span>
                    <FavoriteButton favorites={favorites} poolId={market.id} pair={pairLabel(market)} />
                  </div>;
                })}
              </div>
            </section>}
      </div>
    </main>
    <SiteFooter />
  </div>;
}
