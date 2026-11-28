"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Layers, Plus, Search, Star, X } from "lucide-react";
import { CreatePoolPanel } from "./CreatePoolPanel";
import { MissingPoolRow, PoolRow, PoolsHead, PoolsSkeleton } from "./PoolsList";
import { CREATE_EVENT, QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { useNetworkCopy } from "./NetworkContext";
import { useFavorites } from "./useFavorites";
import { useFeatures } from "./useFeatures";
import { usePoolSparks } from "./usePoolSparks";
import { useRewardPrograms } from "./useRewards";
import { useMarkets } from "./useMarkets";
import { isLowLiquidity } from "../lib/qwakk-market-view";
import { favoritePoolIds, initialPoolsTab, POOLS_TABS, poolsList, poolsSummary, type PoolsTab } from "../lib/qwakk-pools-list";
import { BRAND } from "../lib/brand";
import { searchEmptyCopy, shortQuery } from "../lib/qwakk-search";
import { marketPairSlugs, poolPath } from "../lib/qwakk-pair-slug";

/** The last tab chosen in this browser. Older visits stored "all" or "favorites" here. */
const TAB_KEY = "qwakk-pools-scope";
/** `/api/sparks` reads at most this many pools at once. */
const MAX_SPARKS = 100;
// How long a New pool press waits for the wallet connect it asked for.
const PENDING_CREATE_MS = 120_000;

function Empty({ icon, title, children, action }: { icon?: ReactNode; title?: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty pf-empty">
    {icon && <span className="empty-icon">{icon}</span>}
    {title && <h3>{title}</h3>}
    {children && <p>{children}</p>}
    {action}
  </div>;
}

/**
 * The pools page: a title with one action, a search field, tabs for the order
 * (or favorites), then one list. Low-liquidity pools fold into a closed group
 * at the end of the list instead of mixing in with priced pools.
 */
export function MarketsView() {
  const { markets, state } = useMarkets();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<PoolsTab>("trending");
  // Pools flagged by the indexer as low liquidity (dust or empty reserves) stay folded until asked for.
  const [showLow, setShowLow] = useState(false);
  const favorites = useFavorites();
  const { copy } = useNetworkCopy();
  const tabRefs = useRef<Partial<Record<PoolsTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    // A link with ?q= (or ?view=favorites) opens the list already filtered.
    const params = new URLSearchParams(window.location.search);
    const initial = params.get("q") ?? "";
    const timer = window.setTimeout(() => {
      if (initial) setQuery(initial);
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(TAB_KEY);
      } catch {
        // Storage can be unavailable; Trending is the default.
      }
      setTab(initialPoolsTab(params.get("view"), stored));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function chooseTab(next: PoolsTab, focus = false) {
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {
      // Not remembering the choice is fine.
    }
  }

  function onTabKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = POOLS_TABS.findIndex((item) => item.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      chooseTab(POOLS_TABS[event.key === "Home" ? 0 : POOLS_TABS.length - 1].id, true);
    } else if (step) {
      event.preventDefault();
      chooseTab(POOLS_TABS[(index + step + POOLS_TABS.length) % POOLS_TABS.length].id, true);
    }
  }

  // Each wallet action has its own switch (QWAKK_NATIVE_ACTIONS).
  const features = useFeatures();
  const nativeActions = features.actions.create_pool;
  // Pools with an LP rewards program get a small tag, only while rewards are switched on.
  const rewardPrograms = useRewardPrograms(features.rewards);
  const rewardPools = new Set(features.rewards ? (rewardPrograms.data?.programs ?? []).map((program) => program.poolId) : []);
  const [walletAddress, setWalletAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const [amm, setAmm] = useState<{ poolCreationFee: string | null; minLiquidity: string | null } | null>(null);

  // New pool with a wallet opens the form. Without one it asks QoreX to connect and remembers the press
  // for a short while, so a later, unrelated connect never pops the form open.
  const walletRef = useRef("");
  const pendingCreateRef = useRef(0);
  const startCreate = useCallback(() => {
    if (walletRef.current) { setCreating(true); return; }
    pendingCreateRef.current = Date.now();
    window.dispatchEvent(new Event("qwakk:request-connect"));
  }, []);

  // The rail and top bar "+" link here with ?create=1.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("create") === "1") setCreating(true);
    }, 0);
    window.addEventListener(CREATE_EVENT, startCreate);
    return () => { window.clearTimeout(timer); window.removeEventListener(CREATE_EVENT, startCreate); };
  }, [startCreate]);

  useEffect(() => {
    const restoreWallet = () => {
      const address = window.localStorage.getItem("qwakk-wallet-address") ?? "";
      walletRef.current = address;
      setWalletAddress(address);
      // A New pool press without a wallet opens the form only if the connect it asked for lands soon after.
      if (pendingCreateRef.current) {
        if (address && Date.now() - pendingCreateRef.current < PENDING_CREATE_MS) setCreating(true);
        pendingCreateRef.current = 0;
      }
    };
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

  const summary = poolsSummary(markets);
  // Readable pool links (/pools/qwakk-qor), made from every indexed pool so a shared pair opens the right one.
  const slugs = useMemo(() => marketPairSlugs(markets), [markets]);
  const byId = useMemo(() => new Map(markets.map((market) => [String(market.id), market])), [markets]);
  const sort = tab === "favorites" ? "trending" : tab;
  // Same matcher as the search dialog and the swap picker (lib/qwakk-search.ts); the chosen tab still orders the list.
  const { listed, low } = useMemo(() => poolsList(markets, query, sort), [markets, query, sort]);
  // Favorites keep their starred order and include low-liquidity pools: the visitor picked them.
  const favoriteIds = useMemo(() => favoritePoolIds(favorites.ids, markets, query), [favorites.ids, markets, query]);
  // One batched trend-line read for the pools on screen that are not low liquidity.
  const sparkIds = (tab === "favorites" ? favoriteIds.filter((id) => { const market = byId.get(id); return market !== undefined && !isLowLiquidity(market); }) : listed.map((market) => String(market.id))).slice(0, MAX_SPARKS);
  const sparks = usePoolSparks(sparkIds);
  const noMatch = searchEmptyCopy(query, BRAND.name);

  const row = (market: (typeof markets)[number]) => <PoolRow key={market.id} market={market} favorites={favorites} href={poolPath(market.id, slugs)} rewards={rewardPools.has(String(market.id))} spark={sparks[String(market.id)]} />;

  const unavailable = <Empty title="Pool data is temporarily unavailable">The market indexer could not be reached. This page retries on its own.</Empty>;
  const loading = <><span className="sr-only">{copy("Reading pools from QoreChain Diana…")}</span><PoolsSkeleton /></>;

  // The low-liquidity group: closed by default, one line saying how many and why.
  const lowGroup = low.length > 0 && <div className="pools-low">
    <button type="button" className="pools-low-toggle" aria-expanded={showLow} aria-controls="pools-low-list" onClick={() => setShowLow((open) => !open)}>
      <span className="pools-low-text">
        <b>{low.length === 1 ? "1 low-liquidity pool" : `${low.length} low-liquidity pools`}</b>
        <small>{low.length === 1 ? "It holds too little to give a reliable price." : "Each holds too little to give a reliable price."}</small>
      </span>
      <span className="pools-low-action">{showLow ? "Hide" : "Show"}<ChevronDown size={16} aria-hidden="true" /></span>
    </button>
    {showLow && <ul id="pools-low-list" className="pools-list">{low.map(row)}</ul>}
  </div>;

  let body: ReactNode;
  if (tab === "favorites") {
    body = state === "unavailable" && favorites.ids.length > 0 ? unavailable
      : favoriteIds.length > 0 ? <>
        <PoolsHead />
        <ul className="pools-list">{favoriteIds.map((id) => {
          const market = byId.get(id);
          if (market) return row(market);
          // Until the pool list has loaded, an unknown id is not yet "missing".
          return state === "ready" ? <MissingPoolRow key={id} poolId={id} favorites={favorites} /> : <li key={id} className="pools-item" aria-hidden="true"><span className="pf-skel-row"><i className="is-dot" /><i className="is-line" /><i className="is-end" /></span></li>;
        })}</ul>
      </>
      : !favorites.ready ? favorites.failed ? <Empty title="Favorites could not load">Refresh the page to try again.</Empty> : <Empty>Reading your favorites…</Empty>
      : favorites.ids.length === 0 ? <Empty icon={<Star size={18} />} title="No favorites yet" action={<button type="button" className="btn btn-ghost btn-sm" onClick={() => chooseTab("trending")}>Browse pools</button>}>Tap the star on any pool and it lands here with its price, 24h move and trend line. Stars stay in this browser, no wallet needed.</Empty>
      : <Empty icon={<Search size={18} />} title={`No favorites match “${shortQuery(query)}”`}>Clear the search to see every pool you starred.</Empty>;
  } else if (markets.length === 0) {
    body = state === "loading" ? loading
      : state === "unavailable" ? unavailable
      : <Empty icon={<Layers size={18} />} title="No pools are open yet">{copy("The first native AMM pool on QoreChain Diana will show up here with its price, activity and chart.")}</Empty>;
  } else if (listed.length === 0 && low.length === 0) {
    body = <Empty icon={<Search size={18} />} title={noMatch.title}>{noMatch.body}</Empty>;
  } else {
    body = <>
      {listed.length === 0 && !showLow
        // Only folded pools are left: say so, instead of claiming nothing matches. The group below says why.
        ? <Empty icon={<Layers size={18} />} title={query.trim() ? "Only low-liquidity pools match" : "Only low-liquidity pools are open"} />
        : <PoolsHead />}
      {listed.length > 0 && <ul className="pools-list">{listed.map(row)}</ul>}
      {lowGroup}
    </>;
  }
  const busy = state === "loading" && markets.length === 0;

  return <div className="app-shell">
    <QwakkHeader page="pools" />
    <main className="app-main">
      <div className="container pools-page">
        <section className="pools-head" aria-labelledby="pools-title">
          <div className="pools-title">
            <h1 id="pools-title">Pools</h1>
            <p className="pools-meta">{state === "ready" && markets.length > 0
              ? <><span className="num">{summary.pools} {summary.pools === 1 ? "pool" : "pools"} on {copy("QoreChain Diana")}</span><span aria-hidden="true">·</span><span className="num">{summary.swaps24h.toLocaleString("en-US")} {summary.swaps24h === 1 ? "swap" : "swaps"} in 24h</span></>
              : <span>{copy("Native AMM pools on QoreChain Diana")}</span>}</p>
          </div>
          {/* Without a wallet the same button asks QoreX to connect; the form opens once it does. */}
          {nativeActions && <button type="button" className="btn btn-primary pools-new" aria-haspopup={walletAddress ? "dialog" : undefined} data-create-trigger onClick={startCreate}><Plus size={16} aria-hidden="true" />New pool</button>}
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

        <div className="pools-bar">
          <div className="pf-tabs pools-tabs" role="tablist" aria-label="Order pools">
            {POOLS_TABS.map((item) => <button key={item.id} ref={(element) => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`pools-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="pools-panel" tabIndex={tab === item.id ? 0 : -1} onKeyDown={onTabKey} onClick={() => chooseTab(item.id)}>
              {item.id === "favorites" && <Star size={14} aria-hidden="true" fill={tab === "favorites" ? "currentColor" : "none"} />}
              {item.label}{item.id === "favorites" && favorites.ids.length > 0 && <span className="pf-tab-count num">{favorites.ids.length}</span>}
            </button>)}
          </div>
          <label className="search pools-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Token, pool # or address" aria-label="Filter pools by token name, symbol, pool number or contract address" autoComplete="off" spellCheck={false} /></label>
        </div>

        <section className="panel pf-panel pools-panel" role="tabpanel" id="pools-panel" aria-labelledby={`pools-tab-${tab}`} aria-busy={busy} key={tab}>
          {body}
        </section>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
