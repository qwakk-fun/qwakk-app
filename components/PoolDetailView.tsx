"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { LiquidityPanel } from "./LiquidityPanel";
import { QoraHeader } from "./QoraHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useFeatures } from "./useFeatures";
import { PoolChart, type PoolCandle } from "./PoolChart";
import { formatBaseAmount } from "../lib/qora-assets";
import { BRAND } from "../lib/brand";
import { CHART_INTERVALS, CHART_INTERVAL_LABELS, type ChartInterval } from "../lib/qora-chart";

type Pool = {
  id: string | number;
  pool_type: string;
  status: string;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_name: string | null;
  token_b_name: string | null;
  token_a_decimals: string | number;
  token_b_decimals: string | number;
  reserve_a: string;
  reserve_b: string;
  weighted_avg_price: string | number | null;
  lp_supply?: string | null;
  creator?: string | null;
  created_height?: string | number | null;
};

/** QoreChain AMM params report lp_token_decimals = 6 on Diana and mainnet. */
const LP_TOKEN_DECIMALS = 6;

type Swap = {
  tx_hash: string;
  executed_at: string;
  sender: string | null;
  denom_in: string;
  amount_in: string;
  denom_out: string;
  amount_out: string;
  price_b_per_a: string | number | null;
};

type Detail = { pool: Pool; candles: PoolCandle[]; swaps: Swap[] };

function shortAddress(value: string | null) {
  if (!value) return "Unknown wallet";
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(date);
}

function symbolForDenom(pool: Pool, denom: string) {
  return denom === pool.token_a ? pool.token_a_symbol : denom === pool.token_b ? pool.token_b_symbol : denom.replace(/^u/, "").toUpperCase();
}

function amountForDenom(pool: Pool, denom: string, amount: string) {
  const decimals = denom === pool.token_a ? pool.token_a_decimals : denom === pool.token_b ? pool.token_b_decimals : 0;
  return formatBaseAmount(amount, Number(decimals), 6);
}

function price(value: string | number | null, symbol: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "No swaps yet";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(number)} ${symbol}`;
}

export function PoolDetailView({ poolId }: { poolId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unavailable">("loading");
  const [chartInterval, setChartInterval] = useState<ChartInterval>("1m");
  const { nativeActions } = useFeatures();
  const [walletAddress, setWalletAddress] = useState("");

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qora-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qora:wallet-change", restoreWallet);
    return () => window.removeEventListener("qora:wallet-change", restoreWallet);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/pools/${poolId}?interval=${chartInterval}`, { cache: "no-store" });
        if (response.status === 404) throw new Error("missing");
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as Detail;
        if (active) { setDetail(data); setState("ready"); }
      } catch (error) {
        if (active) setState(error instanceof Error && error.message === "missing" ? "missing" : "unavailable");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    // The indexer polls the chain every few seconds, so read again shortly after a confirmed action.
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qora:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qora:tx-confirmed", reloadSoon); };
  }, [poolId, chartInterval]);

  if (state !== "ready" || !detail) {
    const message = state === "loading" ? "Reading current pool data…" : state === "missing" ? "This pool does not exist on QoreChain Diana." : "Pool data is temporarily unavailable. This page retries on its own.";
    return <div className="app-shell"><QoraHeader page="pools" /><main className="app-main"><div className="container"><Link className="back-link" href="/pools"><ArrowLeft size={15} />All pools</Link><div className="panel empty"><p>{message}</p></div></div></main><SiteFooter /></div>;
  }

  const { pool, candles, swaps } = detail;
  return <div className="app-shell">
    <QoraHeader page="pools" />
    <main className="app-main">
      <div className="container">
        <Link className="back-link" href="/pools"><ArrowLeft size={15} />All pools</Link>
        <section className="pool-head">
          <div className="cell-main">
            <span className="pair-icons"><TokenIcon denom={pool.token_a} size="large" /><TokenIcon denom={pool.token_b} size="large" /></span>
            <div><span className="kicker">Pool #{pool.id}</span><h1>{pool.token_a_symbol} / {pool.token_b_symbol}</h1></div>
          </div>
          <div className="pool-head-price"><span className="stat-label">Latest price</span><strong>{price(candles.at(-1)?.close ?? pool.weighted_avg_price, pool.token_b_symbol)}</strong><span className="subtle">per {pool.token_a_symbol}</span></div>
        </section>

        <section className="stat-row" aria-label="Pool summary">
          <div className="stat-card stat"><span className="stat-label">{pool.token_a_symbol} reserve</span><span className="stat-value num">{formatBaseAmount(pool.reserve_a ?? "0", Number(pool.token_a_decimals), 6)}</span></div>
          <div className="stat-card stat"><span className="stat-label">{pool.token_b_symbol} reserve</span><span className="stat-value num">{formatBaseAmount(pool.reserve_b ?? "0", Number(pool.token_b_decimals), 6)}</span></div>
          <div className="stat-card stat"><span className="stat-label">Recent swaps</span><span className="stat-value num">{swaps.length}</span></div>
        </section>

        <div className="pool-layout">
          <section className="panel" aria-labelledby="pool-chart-title">
            <div className="panel-head">
              <div><span className="panel-title" id="pool-chart-title">{pool.token_a_symbol} price in {pool.token_b_symbol}</span><span className="cell-sub">{CHART_INTERVAL_LABELS[chartInterval]}</span></div>
              <div className="segmented" role="group" aria-label="Chart interval">{CHART_INTERVALS.map((option) => <button type="button" key={option} aria-pressed={option === chartInterval} onClick={() => setChartInterval(option)}>{option}</button>)}</div>
            </div>
            <PoolChart candles={candles} />
          </section>
          <aside className="panel" aria-labelledby="pool-info-title">
            <div className="panel-head"><span className="panel-title" id="pool-info-title">Pool details</span></div>
            <div className="info-list">
              <div><span>Status</span><b>{pool.status}</b></div>
              <div><span>Type</span><b>{pool.pool_type.replace(/_/g, " ")}</b></div>
              <div><span>LP supply</span><b className="num">{pool.lp_supply ? formatBaseAmount(pool.lp_supply, LP_TOKEN_DECIMALS, 4) : "Not available"}</b></div>
              <div><span>Created at block</span><b className="num">{pool.created_height ? new Intl.NumberFormat("en-US").format(Number(pool.created_height)) : "Not available"}</b></div>
              <div><span>Creator</span><b className="mono">{shortAddress(pool.creator ?? null)}</b></div>
            </div>
            <p className="panel-note">Liquidity is held by the pool on QoreChain. {BRAND.name} never holds assets.</p>
            {nativeActions && <>
              <div className="panel-head panel-head-split"><span className="panel-title">Liquidity</span></div>
              {walletAddress
                ? <LiquidityPanel pool={pool} walletAddress={walletAddress} />
                : <div className="panel-body"><button type="button" className="btn btn-primary btn-block" onClick={() => window.dispatchEvent(new Event("qora:request-connect"))}>Connect wallet</button></div>}
            </>}
          </aside>
        </div>

        <section className="panel swaps-table" aria-labelledby="swaps-title" style={{ marginTop: 16 }}>
          <div className="panel-head"><span className="panel-title" id="swaps-title">Recent swaps</span><span className="subtle">{swaps.length} indexed</span></div>
          <div className="table">
            <div className="table-row table-head"><span>Time</span><span>Sold</span><span>Bought</span><span className="hide-sm">Wallet</span><span aria-hidden="true" /></div>
            {swaps.length === 0 && <div className="empty"><p>No swaps have been indexed for this pool yet.</p></div>}
            {swaps.map((swap) => <div className="table-row" key={`${swap.tx_hash}-${swap.executed_at}`}>
              <span className="subtle">{dateTime(swap.executed_at)}</span>
              <span className="num">{amountForDenom(pool, swap.denom_in, swap.amount_in)} {symbolForDenom(pool, swap.denom_in)}</span>
              <span className="num">{amountForDenom(pool, swap.denom_out, swap.amount_out)} {symbolForDenom(pool, swap.denom_out)}</span>
              <span className="mono subtle hide-sm">{shortAddress(swap.sender)}</span>
              <a className="end subtle" href={`https://explore.qore.network/tx/${swap.tx_hash}`} target="_blank" rel="noreferrer" aria-label="Open transaction in the QoreChain explorer"><ExternalLink size={15} /></a>
            </div>)}
          </div>
        </section>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
