"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Search, X } from "lucide-react";
import { BRAND } from "../lib/brand";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketSearchEntry, marketSides, pairLabel } from "../lib/qwakk-market-view";
import { SELECT_POOL_EVENT, isTokenLookup, matchedToken, parseSearchQuery, searchEmptyCopy, searchPools } from "../lib/qwakk-search";
import { DISMISS_SHARE, EXIT_EASE, EXIT_FALLBACK_MS, exitDuration, projectedTravel, rubberband } from "../lib/qwakk-sheet-motion";
import { FavoriteButton } from "./FavoriteButton";
import { TokenIcon } from "./TokenIcon";
import { useFavorites, type Favorites } from "./useFavorites";
import { formatPercentChange, marketChange, useMarkets, type Market } from "./useMarkets";

const RESULT_LIMIT = 30;
const TRENDING_LIMIT = 6;

type Drag = { id: number; startY: number; lastY: number; lastT: number; velocity: number };

/** Usable pools first, then the busiest, so a tie goes to the pool a trader most likely wants. */
function byRelevance(markets: readonly Market[]) {
  return [...markets].sort((a, b) => Number(isLowLiquidity(a)) - Number(isLowLiquidity(b))
    || (Number(b.transactions_24h) || 0) - (Number(a.transactions_24h) || 0)
    || (Number(a.id) || 0) - (Number(b.id) || 0));
}

/** Cmd, Ctrl, Shift or Alt click (new tab, new window, download) is left to the browser. */
function opensElsewhere(event: ReactMouseEvent) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function phoneLayout() {
  return window.matchMedia("(max-width: 760px)").matches;
}

function ResultRow({ market, favorites, onNavigate }: { market: Market; favorites: Favorites; onNavigate: (href: string, poolId: string) => void }) {
  const { base, quote } = marketSides(market);
  const id = String(market.id);
  const lowLiquidity = isLowLiquidity(market);
  const price = lowLiquidity ? null : marketPrice(market);
  const change = lowLiquidity ? null : marketChange(market);
  const pair = pairLabel(market);
  // The pool page explains why a thin or paused pool is not offered; search does not offer it either.
  const tradable = !lowLiquidity && market.status === "active";
  const baseName = marketSearchEntry(market).tokens[0]?.name;
  return <li className="search-row">
    <Link className="search-row-link" href={`/pools/${id}`} data-search-link onClick={(event) => { if (opensElsewhere(event)) return; event.preventDefault(); onNavigate(`/pools/${id}`, id); }}>
      <span className="pair-icons"><TokenIcon denom={base.denom} size="regular" /><TokenIcon denom={quote.denom} size="regular" /></span>
      <span className="search-row-name"><b>{pairLabel(market, " / ")}</b><small>#{id}{baseName ? ` · ${baseName}` : ""}{lowLiquidity && <span className="low-tag">Low liquidity</span>}</small></span>
      <span className="search-row-price num">
        <b>{lowLiquidity ? "Not shown" : price === null ? "No trades yet" : `${formatQuotePrice(price)} ${quote.symbol}`}</b>
        {change !== null && <small className={change >= 0 ? "up" : "down"}>{formatPercentChange(change)}</small>}
      </span>
    </Link>
    {tradable && <Link className="btn btn-ghost btn-sm search-trade" href={`/swap?pool=${id}`} aria-label={`Trade ${pair}`} onClick={(event) => { if (opensElsewhere(event)) return; event.preventDefault(); onNavigate(`/swap?pool=${id}`, id); }}><ArrowLeftRight size={14} aria-hidden="true" /><span className="search-trade-label">Trade</span></Link>}
    <FavoriteButton favorites={favorites} poolId={id} pair={pair} />
  </li>;
}

/**
 * The global search, opened from the top bar and with Cmd or Ctrl+K. It finds
 * pools by token symbol or name, pool number, or a pasted contract address
 * (lib/qwakk-search.ts). A modal <dialog>: the page behind is inert, focus
 * stays inside, Esc closes. On phones it is a bottom sheet that drags down to
 * dismiss, like the QoreX sheet. Mounted only while open, so it reads the
 * pool list fresh each time and costs nothing otherwise.
 */
export function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { markets, state } = useMarkets(30_000);
  const favorites = useFavorites();
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
  }, []);

  // Closing plays the exit, then closes the dialog (focus returns to the opener) and unmounts.
  useEffect(() => {
    if (!closing) return;
    const element = panel.current;
    let done = false;
    const finish = () => { if (!done) { done = true; dialog.current?.close(); onClose(); } };
    const onEnd = (event: TransitionEvent) => { if (event.target === element && (event.propertyName === "transform" || event.propertyName === "opacity")) finish(); };
    element?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    return () => { element?.removeEventListener("transitionend", onEnd); window.clearTimeout(timer); };
  }, [closing, onClose]);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    input.current?.focus();
  }, []);

  // A click whose target is the <dialog> itself landed on the backdrop (the dialog has no padding).
  // Pointer only: keyboard users close with Esc or the close button.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClick = (event: MouseEvent) => { if (event.target === element) requestClose(); };
    element.addEventListener("click", onClick);
    return () => element.removeEventListener("click", onClick);
  }, [requestClose]);

  // Arrow keys walk the results; Up from the first goes back to the field, and typing goes back to it too.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      const all = [...element.querySelectorAll<HTMLAnchorElement>("[data-search-link]")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        const row = active?.closest(".search-row");
        const current = all.findIndex((link) => link === active || Boolean(row?.contains(link)));
        const next = current + (event.key === "ArrowDown" ? 1 : -1);
        if (next < 0) input.current?.focus();
        else all[Math.min(next, all.length - 1)]?.focus();
      } else if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
        input.current?.focus();
      }
    };
    element.addEventListener("keydown", onKey);
    return () => element.removeEventListener("keydown", onKey);
  }, []);

  const ordered = useMemo(() => byRelevance(markets), [markets]);
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const matches = useMemo(() => parsed.kind === "empty" ? [] : searchPools(ordered, parsed, marketSearchEntry, RESULT_LIMIT), [ordered, parsed]);
  const exactToken = isTokenLookup(parsed) ? matchedToken(matches) : null;

  // With nothing typed: favorites first, then the busiest pools.
  const favoriteMarkets = useMemo(() => favorites.ids.map((id) => markets.find((market) => String(market.id) === id)).filter((market): market is Market => Boolean(market)), [favorites.ids, markets]);
  const trending = useMemo(() => ordered.filter((market) => !isLowLiquidity(market) && !favorites.has(market.id)).slice(0, TRENDING_LIMIT), [ordered, favorites]);

  const navigate = useCallback((href: string, poolId: string) => {
    // The swap page stays mounted on a same-page link, so it is told which pool to open.
    if (href.startsWith("/swap") && window.location.pathname === "/swap") window.dispatchEvent(new CustomEvent(SELECT_POOL_EVENT, { detail: poolId }));
    router.push(href);
    dialog.current?.close();
    onClose();
  }, [onClose, router]);

  function onInputKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list.current?.querySelector<HTMLAnchorElement>("[data-search-link]")?.focus();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      // Enter opens the top result.
      const first = parsed.kind === "empty" ? (favoriteMarkets[0] ?? trending[0]) : matches[0]?.item;
      if (first) { event.preventDefault(); navigate(`/pools/${first.id}`, String(first.id)); }
    }
  }

  // Phones only: the grabber and the field's top edge drag the sheet 1:1 with the finger.
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const element = panel.current;
    const target = event.target as HTMLElement;
    if (!element || closingRef.current || !event.isPrimary || event.button !== 0) return;
    if (!target.closest(".sheet-grabber, .search-sheet-head") || target.closest("button, a, input")) return;
    if (!phoneLayout()) return;
    const current = new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;
    element.style.animation = "none";
    element.style.transition = "none";
    element.style.transform = `translateY(${current}px)`;
    element.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startY: event.clientY - current, lastY: event.clientY, lastT: event.timeStamp, velocity: 0 };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const element = panel.current;
    if (!state || !element || event.pointerId !== state.id) return;
    const elapsed = event.timeStamp - state.lastT;
    if (elapsed > 0) state.velocity = 0.8 * ((event.clientY - state.lastY) / elapsed) + 0.2 * state.velocity;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    const offset = event.clientY - state.startY;
    element.style.transform = `translateY(${offset >= 0 ? offset : -rubberband(-offset, element.offsetHeight)}px)`;
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const element = panel.current;
    if (!state || !element || event.pointerId !== state.id) return;
    drag.current = null;
    const offset = Math.max(0, event.clientY - state.startY);
    const velocity = event.type === "pointercancel" || event.timeStamp - state.lastT > 80 ? 0 : state.velocity;
    const height = element.offsetHeight;
    if (event.type !== "pointercancel" && offset + projectedTravel(velocity) > height * DISMISS_SHARE) {
      const remaining = height + 24 - offset;
      element.style.transition = `transform ${Math.round(exitDuration(remaining, velocity))}ms ${EXIT_EASE}`;
      element.style.transform = `translateY(${height + 24}px)`;
      requestClose();
      return;
    }
    element.style.transition = "";
    element.style.transform = "";
  }

  const empty = parsed.kind !== "empty" && matches.length === 0 && state === "ready" ? searchEmptyCopy(query, BRAND.name) : null;
  const row = (market: Market) => <ResultRow key={market.id} market={market} favorites={favorites} onNavigate={navigate} />;

  return <dialog
    ref={dialog}
    className={`search-dialog${closing ? " is-closing" : ""}`}
    aria-labelledby="search-dialog-title"
    // Esc plays the exit instead of vanishing.
    onCancel={(event) => { event.preventDefault(); requestClose(); }}
    // Any close that skipped the cancel path still unmounts, so the top bar never thinks search is open.
    onClose={onClose}
  >
    <div ref={panel} className="search-panel" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <span className="sheet-grabber" aria-hidden="true" />
      <div className="search-sheet-head">
        <h2 id="search-dialog-title" className="sr-only">Search pools</h2>
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKey}
            placeholder="Token, pool # or address"
            aria-label="Search by token name, symbol, pool number or contract address"
            aria-describedby="search-dialog-help"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
        </label>
        <button type="button" className="icon-btn" onClick={requestClose} aria-label="Close search"><X size={18} aria-hidden="true" /></button>
      </div>
      <p id="search-dialog-help" className="sr-only">Arrow keys move through the pools. Enter opens the top pool.</p>

      <div ref={list} className="search-body">
        {state === "loading" && markets.length === 0
          ? <p className="search-note">Reading pools…</p>
          : state === "unavailable"
            ? <div className="empty"><h3>Search is resting for a moment</h3><p>Pool data could not be read. Close this and try again shortly.</p></div>
            : parsed.kind === "empty"
              ? <>
                {favoriteMarkets.length > 0 && <section aria-labelledby="search-favorites-title"><h3 className="search-section-title" id="search-favorites-title">Favorites</h3><ul className="search-results">{favoriteMarkets.map(row)}</ul></section>}
                {trending.length > 0 && <section aria-labelledby="search-trending-title"><h3 className="search-section-title" id="search-trending-title">Trending now</h3><ul className="search-results">{trending.map(row)}</ul></section>}
                {favoriteMarkets.length === 0 && trending.length === 0 && <p className="search-note">No pools are open yet. Search fills up as they arrive.</p>}
              </>
              : empty
                ? <div className="empty"><span className="empty-icon"><Search size={18} aria-hidden="true" /></span><h3>{empty.title}</h3><p>{empty.body}</p></div>
                : <section aria-labelledby="search-results-title">
                  {exactToken && <p className="search-hint"><TokenIcon denom={exactToken.denom} size="small" /><span>This address is <b>{exactToken.symbol}</b>{exactToken.name && exactToken.name !== exactToken.symbol ? ` (${exactToken.name})` : ""}.</span></p>}
                  <h3 className="search-section-title" id="search-results-title">{matches.length === 1 ? "1 pool" : `${matches.length} pools`}</h3>
                  <ul className="search-results">{matches.map((match) => row(match.item))}</ul>
                </section>}
        <p className="sr-only" role="status">{parsed.kind === "empty" || state !== "ready" ? "" : empty ? empty.title : matches.length === 1 ? "1 pool found" : `${matches.length} pools found`}</p>
      </div>
      <div className="search-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
    </div>
  </dialog>;
}
