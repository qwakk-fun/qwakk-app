"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { QoraHeader } from "./QoraHeader";
import { TokenIcon } from "./TokenIcon";
import { PoolChart, type PoolCandle } from "./PoolChart";
import { formatBaseAmount } from "../lib/qora-assets";

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
};

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

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/pools/${poolId}`, { cache: "no-store" });
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
    return () => { active = false; window.clearInterval(timer); };
  }, [poolId]);

  if (state !== "ready" || !detail) {
    const message = state === "loading" ? "Reading current pool data." : state === "missing" ? "This pool is no longer available." : "Pool data is temporarily unavailable. Please refresh shortly.";
    return <main className="market-shell"><QoraHeader page="pools" /><section className="pool-loading"><a href="/pools"><ArrowLeft size={16} />All markets</a><div className="terminal-empty">{message}</div></section></main>;
  }

  const { pool, candles, swaps } = detail;
  return <main className="market-shell pool-detail-shell">
    <QoraHeader page="pools" />
    <section className="pool-titlebar">
      <a className="pool-back" href="/pools"><ArrowLeft size={16} />All markets</a>
      <div className="pool-title-main"><span className="pair-icons"><TokenIcon denom={pool.token_a} size="large" /><TokenIcon denom={pool.token_b} size="large" /></span><div><p>POOL #{pool.id}</p><h1>{pool.token_a_symbol} / {pool.token_b_symbol}</h1><span>{pool.token_a_name || pool.token_a_symbol} and {pool.token_b_name || pool.token_b_symbol}</span></div></div>
      <div className="pool-title-price"><span>Latest price</span><b>{price(candles.at(-1)?.close ?? pool.weighted_avg_price, pool.token_b_symbol)}</b><small>per {pool.token_a_symbol}</small></div>
    </section>

    <section className="pool-stat-grid" aria-label="Pool summary">
      <article><span>Pool type</span><b>{pool.pool_type.replace(/_/g, " ")}</b></article>
      <article><span>{pool.token_a_symbol} reserve</span><b>{formatBaseAmount(pool.reserve_a ?? "0", Number(pool.token_a_decimals), 6)}</b><small>{pool.token_a_symbol}</small></article>
      <article><span>{pool.token_b_symbol} reserve</span><b>{formatBaseAmount(pool.reserve_b ?? "0", Number(pool.token_b_decimals), 6)}</b><small>{pool.token_b_symbol}</small></article>
      <article><span>Recent swaps</span><b>{swaps.length}</b><small>indexed activity</small></article>
    </section>

    <section className="pool-terminal-grid">
      <article className="chart-panel"><div className="panel-title"><div><p>PRICE HISTORY</p><h2>{pool.token_a_symbol} in {pool.token_b_symbol}</h2></div><span>1 minute candles</span></div><PoolChart candles={candles} /></article>
      <aside className="pool-side-panel"><p>MARKET STATUS</p><div className="pool-status"><i /><b>{pool.status}</b></div><div className="pool-side-rule" /><span>Liquidity is held in the pool. Qora does not custody assets.</span><div className="pool-side-rule" /><span>Prices and activity shown here come from indexed QoreChain data.</span></aside>
    </section>

    <section className="transaction-panel"><div className="panel-title"><div><p>ON-CHAIN ACTIVITY</p><h2>Recent swaps</h2></div><span>{swaps.length} indexed</span></div>
      <div className="transactions-table"><div className="transaction-row transaction-head"><span>Time</span><span>Action</span><span>From</span><span>To</span><span>Wallet</span><span>Transaction</span></div>
        {swaps.length === 0 && <div className="terminal-empty">No swaps have been indexed for this pool yet.</div>}
        {swaps.map((swap) => <div className="transaction-row" key={`${swap.tx_hash}-${swap.executed_at}`}><span>{dateTime(swap.executed_at)}</span><span className="swap-label">Swap</span><span>{amountForDenom(pool, swap.denom_in, swap.amount_in)} {symbolForDenom(pool, swap.denom_in)}</span><span>{amountForDenom(pool, swap.denom_out, swap.amount_out)} {symbolForDenom(pool, swap.denom_out)}</span><span>{shortAddress(swap.sender)}</span><a href={`https://explore.qore.network/tx/${swap.tx_hash}`} target="_blank" rel="noreferrer" aria-label="Open transaction in QoreChain explorer"><ExternalLink size={16} /></a></div>)}
      </div>
    </section>
  </main>;
}
