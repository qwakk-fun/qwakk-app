"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, BookOpen, CalendarCheck, ChevronLeft, ChevronRight, Droplets, Layers, Search, Trophy, Wallet } from "lucide-react";
import { Identicon } from "./Identicon";
import { PointsDisclaimer, PointsSeasonLine } from "./PointsShared";
import { QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { useFeatures } from "./useFeatures";
import { POINTS_REFRESH_MS, fetchPoints, useConnectedWallet, usePointsClock } from "./usePoints";
import {
  POINTS_CATEGORIES, POINTS_COLUMNS, POINTS_CONNECT, POINTS_FAQ, POINTS_FAQ_TITLE, POINTS_HERO, POINTS_LOOKUP,
  POINTS_PAGINATION, POINTS_RULES, POINTS_STATES, POINTS_YOU, type PointsCategory,
} from "../lib/qwakk-points-copy";
import { formatCount, formatPointsDecimal, shortPointsAddress } from "../lib/qwakk-points-display";
import { QWAKK_POINTS_PAGE_SIZE, isPointsAddress, type QwakkLeaderboardEntry, type QwakkLeaderboardResponse, type QwakkPointsAddressResponse } from "../lib/qwakk-points";

const CATEGORY_ICONS: Record<PointsCategory, typeof ArrowLeftRight> = {
  swaps: ArrowLeftRight,
  liquidity: Droplets,
  pools: Layers,
  activity: CalendarCheck,
};

const RULES_ID = "how-points-work";

type Board = { status: "loading" | "ready" | "unavailable"; data: QwakkLeaderboardResponse | null };

function pageFromUrl() {
  const value = new URLSearchParams(window.location.search).get("page") ?? "";
  return /^\d+$/.test(value) && Number(value) >= 1 ? Math.min(10_000, Number(value)) : 1;
}

function LeaderboardRow({ entry, isYou }: { entry: QwakkLeaderboardEntry; isYou: boolean }) {
  return <Link className={`table-row points-row ${isYou ? "is-you" : ""}`} href={`/points/${entry.address}`}>
    <span className={`points-rank num ${entry.rank <= 3 ? "is-top" : ""}`}>{formatCount(entry.rank)}</span>
    <span className="cell-main points-wallet">
      <Identicon address={entry.address} size={28} />
      <span className="mono points-address" title={entry.address}>{shortPointsAddress(entry.address)}</span>
      {isYou && <span className="you-badge">{POINTS_YOU.badge}</span>}
    </span>
    <b className="num">{formatPointsDecimal(entry.totalPoints)}</b>
    {POINTS_CATEGORIES.map(({ key }) => <span className="num hide-md" key={key}>{formatPointsDecimal(entry.breakdown[key])}</span>)}
    <span className="num hide-sm">{formatCount(entry.activeDays)}</span>
  </Link>;
}

/** The connected wallet's spot, pinned to the bottom of the table when its row is on another page. */
function PinnedRow({ mine, total }: { mine: QwakkPointsAddressResponse; total: number }) {
  return <Link className="table-row points-pinned" href={`/points/${mine.address}`}>
    <span className="points-pinned-label">{POINTS_YOU.pinnedLabel}</span>
    <span className="cell-main points-wallet">
      <Identicon address={mine.address} size={28} />
      <span className="mono points-address" title={mine.address}>{shortPointsAddress(mine.address)}</span>
      <span className="you-badge">{POINTS_YOU.badge}</span>
    </span>
    <span className="points-pinned-rank">
      <b className="num">{mine.ranked && mine.rank !== null ? POINTS_YOU.pinnedRank(formatCount(mine.rank), formatCount(total)) : POINTS_YOU.pinnedUnranked}</b>
      <span className="points-pinned-link">{POINTS_YOU.pinnedLink}<ChevronRight size={14} aria-hidden="true" /></span>
    </span>
  </Link>;
}

function LookupForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = value.trim().toLowerCase();
    if (!isPointsAddress(address)) return setInvalid(true);
    setInvalid(false);
    router.push(`/points/${address}`);
  }

  return <form className="points-lookup" onSubmit={submit} noValidate>
    <label className="points-lookup-label" htmlFor="points-lookup">{POINTS_LOOKUP.label}</label>
    <div className="points-lookup-row">
      <span className="search"><Search size={16} aria-hidden="true" /><input id="points-lookup" type="text" value={value} placeholder={POINTS_LOOKUP.placeholder} autoComplete="off" spellCheck={false} aria-invalid={invalid || undefined} aria-describedby={invalid ? "points-lookup-error" : undefined} onChange={(event) => { setValue(event.target.value); setInvalid(false); }} /></span>
      <button type="submit" className="btn btn-ghost">{POINTS_LOOKUP.button}</button>
    </div>
    {invalid && <p className="form-error" id="points-lookup-error" role="alert">{POINTS_LOOKUP.invalid}</p>}
  </form>;
}

function Rules() {
  return <section className="points-rules" id={RULES_ID} aria-labelledby="points-rules-title">
    <div className="points-section-head">
      <h2 id="points-rules-title">{POINTS_RULES.title}</h2>
      <p>{POINTS_RULES.intro}</p>
    </div>
    <div className="points-rule-grid">
      {POINTS_RULES.cards.map((card) => {
        const Icon = CATEGORY_ICONS[card.key];
        return <article className="fee-card points-rule" key={card.key}>
          <span className="fee-card-icon"><Icon size={18} aria-hidden="true" /></span>
          <h3>{card.title}</h3>
          <ul>{card.lines.map((line) => <li key={line}>{line}</li>)}</ul>
          {card.example && <p className="points-example">{card.example}</p>}
        </article>;
      })}
    </div>
    <ul className="points-fine">{POINTS_RULES.fine.map((line) => <li key={line}>{line}</li>)}</ul>
    <PointsDisclaimer />
  </section>;
}

function Faq() {
  return <section className="points-faq" aria-labelledby="points-faq-title">
    <div className="points-section-head"><h2 id="points-faq-title">{POINTS_FAQ_TITLE}</h2></div>
    <div className="panel points-faq-list">
      {POINTS_FAQ.map((item) => <details key={item.question}>
        <summary>{item.question}<ChevronRight size={16} aria-hidden="true" /></summary>
        <p>{item.answer}</p>
      </details>)}
    </div>
  </section>;
}

/** The testnet points leaderboard, with the rules and FAQ under it. */
export function PointsView() {
  const wallet = useConnectedWallet();
  // The empty state points people to a swap, so it follows the swap switch.
  const nativeActions = useFeatures().actions.swap;
  const now = usePointsClock();
  const [page, setPage] = useState(1);
  const [board, setBoard] = useState<Board>({ status: "loading", data: null });
  const [mine, setMine] = useState<QwakkPointsAddressResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const tableRef = useRef<HTMLElement>(null);

  // Leaderboard pages link with ?page=N.
  useEffect(() => {
    const timer = window.setTimeout(() => setPage(pageFromUrl()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const result = await fetchPoints<QwakkLeaderboardResponse>(`/api/points?page=${page}&pageSize=${QWAKK_POINTS_PAGE_SIZE}`, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok" && Array.isArray(result.data.entries) && result.data.season && result.data.pagination) {
        setBoard({ status: "ready", data: result.data });
      } else {
        // A failed background refresh keeps the page that is already on screen.
        setBoard((current) => current.data?.pagination.page === page ? current : { status: "unavailable", data: null });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), POINTS_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [page, reloadKey]);

  // The connected wallet's own rank, for the pinned row when it is off this page.
  useEffect(() => {
    if (!isPointsAddress(wallet)) {
      const timer = window.setTimeout(() => setMine(null), 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    async function load() {
      const result = await fetchPoints<QwakkPointsAddressResponse>(`/api/points/${wallet}`, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok") setMine(result.data);
    }
    void load();
    const timer = window.setInterval(() => void load(), POINTS_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [wallet, reloadKey]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    try {
      window.history.replaceState(null, "", next > 1 ? `?page=${next}` : window.location.pathname);
    } catch {
      // The page still works without the URL in step.
    }
    tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const data = board.data;
  const pagination = data?.pagination;
  // A page past the end (an old link) jumps back to the last page.
  useEffect(() => {
    if (!pagination || pagination.total === 0 || page <= pagination.totalPages) return;
    const timer = window.setTimeout(() => goToPage(pagination.totalPages), 0);
    return () => window.clearTimeout(timer);
  }, [pagination, page, goToPage]);

  const fetching = Boolean(data && data.pagination.page !== page);
  const entries = data?.entries ?? [];
  const total = pagination?.total ?? 0;
  const youOnPage = Boolean(wallet) && entries.some((entry) => entry.address === wallet);
  const showPinned = Boolean(wallet && mine && mine.address === wallet && !youOnPage && entries.length);
  const empty = board.status === "ready" && total === 0;

  return <div className="app-shell">
    <QwakkHeader page="points" />
    <main className="app-main">
      <div className="container points">
        <section className="page-head points-head">
          <div>
            <span className="kicker">{POINTS_HERO.kicker}</span>
            <h1>{POINTS_HERO.title}</h1>
            <p>{POINTS_HERO.subline}</p>
            <PointsSeasonLine season={data?.season ?? null} now={now} extra={total > 0 ? POINTS_HERO.ranked(formatCount(total)) : undefined} />
          </div>
        </section>
        <PointsDisclaimer className="is-banner" />

        {!wallet && <section className="panel points-connect" aria-labelledby="points-connect-title">
          <span className="empty-icon"><Wallet size={18} aria-hidden="true" /></span>
          <div>
            <h2 id="points-connect-title">{POINTS_CONNECT.title}</h2>
            <p>{POINTS_CONNECT.body}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>{POINTS_CONNECT.button}</button>
        </section>}

        <section className="panel points-board" aria-label={POINTS_COLUMNS.tableLabel} ref={tableRef}>
          <div className="panel-head points-board-head"><LookupForm /></div>
          {board.status === "loading"
            ? <div className="points-loading" aria-busy="true"><p className="subtle">{POINTS_STATES.loading}</p>{Array.from({ length: 6 }, (_, index) => <span className="row-skeleton" key={index} />)}</div>
            : board.status === "unavailable"
              ? <div className="empty">
                <span className="empty-icon"><Trophy size={18} aria-hidden="true" /></span>
                <h3>{POINTS_STATES.unavailable.title}</h3>
                <p>{POINTS_STATES.unavailable.body}</p>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setBoard({ status: "loading", data: null }); setReloadKey((value) => value + 1); }}>{POINTS_STATES.unavailable.button}</button>
              </div>
              : empty
                ? nativeActions
                  ? <div className="empty">
                    <span className="empty-icon"><Trophy size={18} aria-hidden="true" /></span>
                    <h3>{POINTS_STATES.emptyOpen.title}</h3>
                    <p>{POINTS_STATES.emptyOpen.body}</p>
                    <Link className="btn btn-primary" href="/swap">{POINTS_STATES.emptyOpen.button}</Link>
                  </div>
                  : <div className="empty">
                    <span className="empty-icon"><Trophy size={18} aria-hidden="true" /></span>
                    <h3>{POINTS_STATES.emptyClosed.title}</h3>
                    <p>{POINTS_STATES.emptyClosed.body}</p>
                    <a className="btn btn-ghost" href={`#${RULES_ID}`}><BookOpen size={15} aria-hidden="true" />{POINTS_STATES.emptyClosed.button}</a>
                  </div>
                : <>
                  <div className={`table points-table ${fetching ? "is-dimmed" : ""}`} aria-busy={fetching || undefined}>
                    <div className="table-row table-head">
                      <span>{POINTS_COLUMNS.rank}</span>
                      <span>{POINTS_COLUMNS.wallet}</span>
                      <span className="num has-hint" title={POINTS_COLUMNS.totalTooltip}>{POINTS_COLUMNS.total}</span>
                      {POINTS_CATEGORIES.map(({ key, label, tooltip }) => <span className="num hide-md has-hint" title={tooltip} key={key}>{label}</span>)}
                      <span className="num hide-sm has-hint" title={POINTS_COLUMNS.daysTooltip}>{POINTS_COLUMNS.days}</span>
                    </div>
                    {entries.map((entry) => <LeaderboardRow entry={entry} isYou={entry.address === wallet} key={entry.address} />)}
                    {showPinned && mine && <PinnedRow mine={mine} total={total} />}
                  </div>
                  {pagination && pagination.totalPages > 1 && <nav className="points-pages" aria-label={POINTS_PAGINATION.aria}>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1 || fetching} onClick={() => goToPage(page - 1)}><ChevronLeft size={15} aria-hidden="true" />{POINTS_PAGINATION.prev}</button>
                    <span className="subtle num" aria-live="polite">{POINTS_PAGINATION.status(formatCount(Math.min(page, pagination.totalPages)), formatCount(pagination.totalPages))}</span>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={page >= pagination.totalPages || fetching} onClick={() => goToPage(page + 1)}>{POINTS_PAGINATION.next}<ChevronRight size={15} aria-hidden="true" /></button>
                  </nav>}
                </>}
        </section>

        <Rules />
        <Faq />
      </div>
    </main>
    <SiteFooter />
  </div>;
}
