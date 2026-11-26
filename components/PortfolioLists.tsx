"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronRight, Droplets, ExternalLink, Layers, Send, Wallet } from "lucide-react";
import { formatUsdCompact, formatUsdPrice } from "../lib/qor-price";
import { explorerTxUrl } from "../lib/qwakk-network";
import { formatQor, formatQorPerToken, formatTokenAmount, groupDigits } from "../lib/qwakk-pnl-display";
import { formatPoolShare } from "../lib/qwakk-portfolio";
import { formatVisibleAmount } from "../lib/qwakk-assets";
import { FaucetHint } from "./FaucetHint";
import { TokenIcon } from "./TokenIcon";
import type { useAssets } from "./useAssets";

type Resolve = ReturnType<typeof useAssets>;

/** One held token as the Tokens tab shows it. `uqor` is null without a usable QOR price. */
export type TokenRow = {
  denom: string;
  symbol: string;
  name: string;
  decimals: number | null;
  amount: string;
  qorPerToken: string | null;
  lowLiquidity: boolean;
  uqor: bigint | null;
  sendable: boolean;
};

export type Position = { poolId: string; tokenA: string; tokenB: string; lpBalance: string; lpSupply: string };
export type Activity = { hash: string; timestamp: string; status: "success" | "failed"; label: string; direction: "in" | "out" | "action"; amount: string; denom: string };

function SkeletonRows({ count = 3 }: { count?: number }) {
  return <div className="pf-skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span key={index} className="pf-skel-row"><i className="is-dot" /><i className="is-line" /><i className="is-end" /></span>)}
  </div>;
}

function Failed({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return <div className="empty pf-empty">
    <h3>{title}</h3>
    <p>{body}</p>
    <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Try again</button>
  </div>;
}

/** The wallet's tokens: balance, price and QOR value, with a Send shortcut on each token that can be sent. */
export function TokensPanel({ rows, loading, error, qorUsd, sendEnabled, onSend, onReceive, onRetry }: {
  rows: readonly TokenRow[];
  loading: boolean;
  error: boolean;
  qorUsd: number | null;
  /** Null hides Send (the action is switched off). A string disables it with that reason. */
  sendEnabled: true | string | null;
  onSend: (denom: string) => void;
  onReceive: () => void;
  onRetry: () => void;
}) {
  if (error && !rows.length) return <section className="panel pf-panel"><Failed title="Balances could not be loaded" body="This is usually temporary. Try again in a moment." onRetry={onRetry} /></section>;
  if (loading && !rows.length) return <section className="panel pf-panel" aria-busy="true"><span className="sr-only">Reading your balances…</span><SkeletonRows /></section>;
  if (!rows.length) return <section className="panel pf-panel">
    <div className="empty pf-empty">
      <span className="empty-icon"><Wallet size={18} /></span>
      <h3>No tokens here yet</h3>
      <p>Tokens sent to this wallet land here. Share your address to get some.</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReceive}>Show my address</button>
      <FaucetHint />
    </div>
  </section>;

  return <section className="panel pf-panel" aria-busy={loading}>
    <div className="pf-row pf-tokens-row pf-head" aria-hidden="true"><span>Token</span><span className="hide-sm">Price</span><span>Balance</span><span /></div>
    <ul>{rows.map((row) => {
      const isQor = row.denom === "uqor";
      const price = isQor ? (qorUsd === null ? null : formatUsdPrice(qorUsd)) : row.qorPerToken ? `${formatQorPerToken(row.qorPerToken)} QOR` : null;
      const usd = isQor && qorUsd !== null && row.decimals !== null ? Number(formatVisibleAmount(row.amount, row.decimals, 6)) * qorUsd : null;
      const worth = isQor ? (usd === null ? null : `≈ ${formatUsdCompact(usd)}`)
        : row.uqor !== null ? `≈ ${formatQor(row.uqor.toString())} QOR`
        : row.lowLiquidity ? "Small pool, not valued"
        : "No price yet";
      return <li key={row.denom} className="pf-row pf-tokens-row">
        <span className="cell-main">
          <TokenIcon denom={row.denom} size="regular" />
          <span><b>{row.symbol}</b><small>{row.name !== row.symbol ? row.name : isQor ? "QoreChain" : "Token"}</small></span>
        </span>
        <span className="pf-price num hide-sm">{price ?? <span className="subtle">No price yet</span>}</span>
        <span className="pf-amount">
          <b className="num">{formatTokenAmount(row.amount, row.decimals)}</b>
          <small className={`num${row.uqor === null && !isQor ? " is-muted" : ""}`}>{worth ?? ""}</small>
        </span>
        <span className="pf-row-action">
          {row.sendable && sendEnabled !== null && <button type="button" className="pf-send-btn" onClick={() => onSend(row.denom)} disabled={sendEnabled !== true} title={sendEnabled === true ? undefined : sendEnabled} aria-label={`Send ${row.symbol}`}>
            <Send size={15} aria-hidden="true" /><span className="pf-send-label">Send</span>
          </button>}
        </span>
      </li>;
    })}</ul>
  </section>;
}

/** Pools where the wallet holds a share, linking to each pool page. */
export function PoolsPanel({ positions, loading, resolve, onRetry }: { positions: readonly Position[] | null; loading: boolean; resolve: Resolve; onRetry: () => void }) {
  if (positions === null && loading) return <section className="panel pf-panel" aria-busy="true"><span className="sr-only">Checking your pool shares…</span><SkeletonRows count={2} /></section>;
  if (positions === null) return <section className="panel pf-panel"><Failed title="Pool shares could not be read" body="QoreChain did not answer in time. Try again in a moment." onRetry={onRetry} /></section>;
  if (!positions.length) return <section className="panel pf-panel">
    <div className="empty pf-empty">
      <span className="empty-icon"><Droplets size={18} /></span>
      <h3>No pool shares yet</h3>
      <p>Add liquidity to a pool and your share, and the fees it earns, show up here.</p>
      <Link className="btn btn-ghost btn-sm" href="/pools">Browse pools</Link>
    </div>
  </section>;

  return <section className="panel pf-panel" aria-busy={loading}>
    <ul>{positions.map((position) => {
      const a = resolve(position.tokenA);
      const b = resolve(position.tokenB);
      const share = formatPoolShare(position.lpBalance, position.lpSupply);
      return <li key={position.poolId}>
        <Link className="pf-row pf-pools-row" href={`/pools/${encodeURIComponent(position.poolId)}`}>
          <span className="cell-main">
            <span className="pair-icons"><TokenIcon denom={position.tokenA} size="regular" /><TokenIcon denom={position.tokenB} size="regular" /></span>
            <span><b>{a.symbol} / {b.symbol}</b><small>Pool #{position.poolId}</small></span>
          </span>
          <span className="pf-amount">
            <b className="num">{share ?? "Share unknown"}</b>
            <small>{share ? "of the pool" : `${groupDigits(position.lpBalance)} LP units`}</small>
          </span>
          <ChevronRight size={16} className="pf-chevron" aria-hidden="true" />
        </Link>
      </li>;
    })}</ul>
  </section>;
}

const TIME = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The wallet's latest transactions, each opening in the QoreChain explorer. */
export function ActivityPanel({ items, loading, error, resolve, onRetry }: { items: readonly Activity[]; loading: boolean; error: boolean; resolve: Resolve; onRetry: () => void }) {
  if (error && !items.length) return <section className="panel pf-panel"><Failed title="Activity could not be loaded" body="Recent activity could not be read right now. Try again in a moment." onRetry={onRetry} /></section>;
  if (loading && !items.length) return <section className="panel pf-panel" aria-busy="true"><span className="sr-only">Reading your recent activity…</span><SkeletonRows /></section>;
  if (!items.length) return <section className="panel pf-panel">
    <div className="empty pf-empty">
      <span className="empty-icon"><Layers size={18} /></span>
      <h3>Nothing on record yet</h3>
      <p>Swaps, transfers and pool moves from this wallet appear here once they land on chain.</p>
    </div>
  </section>;

  return <section className="panel pf-panel" aria-busy={loading}>
    <ul>{items.map((item) => {
      const asset = resolve(item.denom);
      const sign = item.direction === "in" ? "+" : item.direction === "out" ? "−" : "";
      const Icon = item.direction === "in" ? ArrowDownLeft : item.direction === "out" ? ArrowUpRight : ArrowLeftRight;
      const when = item.timestamp ? TIME.format(new Date(item.timestamp)) : "Time unknown";
      return <li key={item.hash}>
        <a className="pf-row pf-activity-row" href={explorerTxUrl(item.hash)} target="_blank" rel="noreferrer">
          <span className={`pf-activity-icon is-${item.direction}`}><Icon size={15} aria-hidden="true" /></span>
          <span className="pf-activity-main">
            <b>{item.label}{item.status === "failed" && <span className="pf-failed">Failed</span>}</b>
            <small className="num">{when}</small>
          </span>
          <span className="pf-amount">
            {item.amount ? <b className="num">{sign}{formatTokenAmount(item.amount, asset.decimals)} {asset.symbol}</b> : <ExternalLink size={14} className="subtle" aria-label="Open in explorer" />}
          </span>
        </a>
      </li>;
    })}</ul>
  </section>;
}
