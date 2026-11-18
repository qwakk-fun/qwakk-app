"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { formatTokenAmount, resolveUsableAsset } from "../lib/qwakk-asset-resolve";
import { displaySymbol } from "../lib/qwakk-assets";

/** One indexed swap from `/api/pools/:id`. */
export type PoolSwap = {
  tx_hash: string;
  executed_at: string;
  sender: string | null;
  denom_in: string;
  amount_in: string;
  denom_out: string;
  amount_out: string;
  price_b_per_a: string | number | null;
};

/** The pool fields the rows need to name and scale amounts. */
export type SwapsPool = {
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: string | number | null;
  token_b_decimals: string | number | null;
};

export function shortAddress(value: string | null) {
  if (!value) return "Unknown wallet";
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return timeFormat.format(date);
}

function symbolForDenom(pool: SwapsPool, denom: string) {
  return denom === pool.token_a ? pool.token_a_symbol : denom === pool.token_b ? pool.token_b_symbol : displaySymbol(denom);
}

/** Display only: an amount with its symbol, labeled as base units when the decimals are unknown. */
function amountLabel(pool: SwapsPool, denom: string, amount: string) {
  const decimals = denom === pool.token_a ? pool.token_a_decimals : denom === pool.token_b ? pool.token_b_decimals : undefined;
  const asset = resolveUsableAsset(denom, undefined, { symbol: symbolForDenom(pool, denom), decimals });
  return formatTokenAmount(amount, asset.displayDecimals, symbolForDenom(pool, denom));
}

/**
 * A pool's indexed swaps, newest first, one page at a time, each linked to the
 * QoreChain explorer. Shared by the pool page and the swap page. Key it by
 * pool, so a switched pool starts on its first page.
 */
export function RecentSwaps({ pool, swaps, pageSize = 10, titleId = "swaps-title" }: { pool: SwapsPool; swaps: PoolSwap[]; pageSize?: number; titleId?: string }) {
  const [page, setPage] = useState(1);
  // A refresh that shrinks the list keeps the page in range.
  const pages = Math.max(1, Math.ceil(swaps.length / pageSize));
  const current = Math.min(page, pages);
  const visible = swaps.slice((current - 1) * pageSize, current * pageSize);
  return <section className="panel swaps-table" aria-labelledby={titleId}>
    <div className="panel-head"><span className="panel-title" id={titleId}>Recent swaps</span><span className="subtle">{swaps.length} indexed</span></div>
    <div className="table">
      <div className="table-row table-head"><span>Time</span><span className="end">Sold</span><span className="end">Bought</span><span className="hide-sm">Wallet</span><span aria-hidden="true" /></div>
      {swaps.length === 0 && <div className="empty"><p>No swaps have been indexed for this pool yet.</p></div>}
      {visible.map((swap) => <div className="table-row" key={`${swap.tx_hash}-${swap.executed_at}`}>
        <span className="subtle">{dateTime(swap.executed_at)}</span>
        <span className="num">{amountLabel(pool, swap.denom_in, swap.amount_in)}</span>
        <span className="num">{amountLabel(pool, swap.denom_out, swap.amount_out)}</span>
        <span className="mono subtle hide-sm">{shortAddress(swap.sender)}</span>
        <a className="end subtle" href={`https://explore.qore.network/tx/${swap.tx_hash}`} target="_blank" rel="noreferrer" aria-label="Open transaction in the QoreChain explorer"><ExternalLink size={15} /></a>
      </div>)}
    </div>
    {pages > 1 && <nav className="table-pages" aria-label="Recent swaps pages">
      <button type="button" className="btn btn-ghost btn-sm" disabled={current <= 1} onClick={() => setPage(current - 1)}><ChevronLeft size={15} aria-hidden="true" />Newer</button>
      <span className="subtle num" aria-live="polite">Page {current} of {pages}</span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>Older<ChevronRight size={15} aria-hidden="true" /></button>
    </nav>}
  </section>;
}
