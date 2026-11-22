"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Search } from "lucide-react";
import { Identicon } from "./Identicon";
import { PointsDisclaimer, PointsSeasonLine } from "./PointsShared";
import { QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { POINTS_REFRESH_MS, fetchPoints, useConnectedWallet, usePointsClock } from "./usePoints";
import { POINTS_CATEGORIES, POINTS_DAYS, POINTS_POOLS, POINTS_STATS, POINTS_WALLET } from "../lib/qwakk-points-copy";
import { formatCount, formatPointsDay, formatPointsDecimal, pointsShare, shortPointsAddress } from "../lib/qwakk-points-display";
import { isPointsAddress, type QwakkPointsAddressResponse } from "../lib/qwakk-points";

type View = { status: "loading" | "ready" | "invalid" | "unavailable"; data: QwakkPointsAddressResponse | null };

function Shell({ children }: { children: ReactNode }) {
  return <div className="app-shell">
    <QwakkHeader page="points" />
    <main className="app-main">
      <div className="container points">
        <Link className="back-link" href="/points"><ArrowLeft size={15} aria-hidden="true" />{POINTS_WALLET.back}</Link>
        {children}
      </div>
    </main>
    <SiteFooter />
  </div>;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked; the full address stays selectable on the page.
    }
  }

  return <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
    {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    <span aria-live="polite">{copied ? POINTS_WALLET.copied : POINTS_WALLET.copy}</span>
  </button>;
}

const POOL_STATUS_CLASS = { locked: "", unlocked: "is-unlocked", over_limit: "is-limit", not_scored: "" } as const;

function poolStatusCopy(pool: QwakkPointsAddressResponse["pools"][number]) {
  const required = formatCount(pool.requiredTraders);
  switch (pool.status) {
    case "locked": return { label: POINTS_POOLS.status.locked.label(formatCount(pool.distinctTraders), required), tooltip: POINTS_POOLS.status.locked.tooltip(required) };
    case "unlocked": return { label: POINTS_POOLS.status.unlocked.label(formatPointsDecimal(pool.points)), tooltip: POINTS_POOLS.status.unlocked.tooltip(required) };
    case "over_limit": return { label: POINTS_POOLS.status.over_limit.label(), tooltip: POINTS_POOLS.status.over_limit.tooltip() };
    default: return { label: POINTS_POOLS.status.not_scored.label(), tooltip: POINTS_POOLS.status.not_scored.tooltip() };
  }
}

/** Points, rank, breakdown and daily history for one wallet. */
export function PointsWalletView({ address }: { address: string }) {
  const wallet = useConnectedWallet();
  const now = usePointsClock();
  const valid = isPointsAddress(address);
  const [view, setView] = useState<View>({ status: valid ? "loading" : "invalid", data: null });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    async function load() {
      const result = await fetchPoints<QwakkPointsAddressResponse>(`/api/points/${address}`, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "ok" && result.data.season && result.data.breakdown && result.data.stats) setView({ status: "ready", data: result.data });
      else if (result.kind === "invalid") setView({ status: "invalid", data: null });
      // A failed background refresh keeps what is already on screen.
      else setView((current) => current.data ? current : { status: "unavailable", data: null });
    }
    void load();
    const timer = window.setInterval(() => void load(), POINTS_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [address, valid, reloadKey]);

  if (view.status === "invalid") {
    return <Shell><section className="panel empty">
      <span className="empty-icon"><Search size={18} aria-hidden="true" /></span>
      <h1 className="points-state-title">{POINTS_WALLET.invalid.title}</h1>
      <p>{POINTS_WALLET.invalid.body}</p>
    </section></Shell>;
  }
  if (view.status === "unavailable") {
    return <Shell><section className="panel empty">
      <h1 className="points-state-title">{POINTS_WALLET.unavailable.title}</h1>
      <p>{POINTS_WALLET.unavailable.body}</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setView({ status: "loading", data: null }); setReloadKey((value) => value + 1); }}>{POINTS_WALLET.unavailable.button}</button>
    </section></Shell>;
  }
  if (!view.data) {
    return <Shell><section className="panel empty" aria-busy="true"><p>{POINTS_WALLET.loading}</p></section></Shell>;
  }

  const data = view.data;
  const isYours = wallet === data.address;
  const stats = [
    { key: "swapVolume", ...POINTS_STATS.swapVolume, text: POINTS_STATS.swapVolume.value(formatPointsDecimal(data.stats.swapVolumeQor)) },
    { key: "roundTrip", ...POINTS_STATS.roundTrip, text: POINTS_STATS.roundTrip.value(formatPointsDecimal(data.stats.roundTripVolumeQor)) },
    { key: "liquidityHours", ...POINTS_STATS.liquidityHours, text: POINTS_STATS.liquidityHours.value(formatPointsDecimal(data.stats.liquidityQorHours)) },
    { key: "poolsCreated", ...POINTS_STATS.poolsCreated, text: POINTS_STATS.poolsCreated.value(formatCount(data.stats.poolsCreated)) },
    { key: "poolsUnlocked", ...POINTS_STATS.poolsUnlocked, text: POINTS_STATS.poolsUnlocked.value(formatCount(data.stats.poolsUnlocked)) },
    { key: "activeDays", ...POINTS_STATS.activeDays, text: POINTS_STATS.activeDays.value(formatCount(data.activeDays)) },
  ];

  return <Shell>
    <section className="page-head points-wallet-head">
      <div className="points-wallet-id">
        <Identicon address={data.address} size={52} />
        <div>
          <span className="kicker">{POINTS_WALLET.kicker}</span>
          <h1 className="mono" title={data.address}>{shortPointsAddress(data.address)}</h1>
          <span className="address-value">{data.address}</span>
          <PointsSeasonLine season={data.season} now={now} />
        </div>
      </div>
      <div className="page-head-actions">
        {isYours && <span className="you-badge is-large">{POINTS_WALLET.yours}</span>}
        <CopyAddress address={data.address} />
      </div>
    </section>
    <PointsDisclaimer className="is-banner" />

    <section className="points-summary" aria-label={POINTS_WALLET.kicker}>
      <div className="stat-card stat">
        <span className="stat-label">{POINTS_WALLET.rankLabel}</span>
        {data.ranked && data.rank !== null
          ? <span className="stat-value num">{POINTS_WALLET.rankValue(formatCount(data.rank), formatCount(data.season.participants))}</span>
          : <><span className="stat-value">{data.flagged ? POINTS_WALLET.flaggedTitle : POINTS_WALLET.unrankedTitle}</span><span className="subtle">{data.flagged ? POINTS_WALLET.flaggedBody : POINTS_WALLET.unrankedBody}</span></>}
      </div>
      <div className="stat-card stat">
        <span className="stat-label">{POINTS_WALLET.totalLabel}</span>
        <span className="stat-value num">{formatPointsDecimal(data.totalPoints)}</span>
      </div>
    </section>

    <div className="points-wallet-grid">
      <section className="panel" aria-labelledby="points-breakdown-title">
        <div className="panel-head"><span className="panel-title" id="points-breakdown-title">{POINTS_WALLET.breakdownTitle}</span></div>
        <ul className="points-breakdown">
          {POINTS_CATEGORIES.map(({ key, label, tooltip }) => <li key={key}>
            <div className="points-breakdown-top"><b>{label}</b><b className="num">{formatPointsDecimal(data.breakdown[key])}</b></div>
            <span className="points-bar" aria-hidden="true"><i style={{ width: `${pointsShare(data.breakdown[key], data.totalPoints)}%` }} /></span>
            <small className="subtle">{tooltip}</small>
          </li>)}
        </ul>
      </section>

      <section className="panel" aria-labelledby="points-pools-title">
        <div className="panel-head"><span className="panel-title" id="points-pools-title">{POINTS_POOLS.title}</span></div>
        {data.pools.length === 0
          ? <div className="empty"><p>{POINTS_POOLS.empty}</p></div>
          : <ul className="points-pools">{data.pools.map((pool) => {
            const copy = poolStatusCopy(pool);
            return <li key={pool.poolId}>
              <Link className="points-pool-link" href={`/pools/${pool.poolId}`}>Pool #{pool.poolId}</Link>
              <span className={`points-status ${POOL_STATUS_CLASS[pool.status] ?? ""}`}>{copy.label}</span>
              <small className="subtle">{copy.tooltip}</small>
            </li>;
          })}</ul>}
      </section>
    </div>

    <div className="panel points-stats-panel">
      <dl className="points-stats">
        {stats.map((stat) => <div key={stat.key}>
          <dt>{stat.label}</dt>
          <dd className="num">{stat.text}</dd>
          {stat.tooltip && <small className="subtle">{stat.tooltip}</small>}
        </div>)}
      </dl>
    </div>

    <section className="panel points-days" aria-labelledby="points-days-title">
      <div className="panel-head"><span className="panel-title" id="points-days-title">{POINTS_DAYS.title}</span><span className="subtle">{POINTS_DAYS.note}</span></div>
      {data.days.length === 0
        ? <div className="empty"><p>{POINTS_DAYS.empty}</p></div>
        : <div className="table">
          <div className="table-row table-head">
            <span>{POINTS_DAYS.colDay}</span>
            <span className="num hide-sm">{POINTS_DAYS.colVolume}</span>
            <span className="num hide-sm">{POINTS_DAYS.colRoundTrip}</span>
            <span className="num">{POINTS_DAYS.colSwapPoints}</span>
            <span className="num">{POINTS_DAYS.colLiquidityPoints}</span>
            <span className="num">{POINTS_DAYS.colActive}</span>
          </div>
          {data.days.map((day) => <div className="table-row" key={day.day}>
            <span>{formatPointsDay(day.day)}</span>
            <span className="num hide-sm">{formatPointsDecimal(day.swapVolumeQor)} QOR</span>
            <span className="num hide-sm">{formatPointsDecimal(day.roundTripVolumeQor)} QOR</span>
            <span className="num">{formatPointsDecimal(day.swapPoints)}</span>
            <span className="num">{formatPointsDecimal(day.liquidityPoints)}</span>
            <span className={`num ${day.active ? "points-active" : "subtle"}`}>{day.active ? POINTS_DAYS.activeYes : POINTS_DAYS.activeNo}</span>
          </div>)}
        </div>}
    </section>
  </Shell>;
}
