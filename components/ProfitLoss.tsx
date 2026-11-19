"use client";

import { useState } from "react";
import { AlertTriangle, Info, TrendingUp } from "lucide-react";
import { BRAND } from "../lib/brand";
import {
  PNL_ERROR_COPY,
  formatPnlPercent,
  formatQor,
  formatQorPerToken,
  formatSignedQor,
  formatTokenAmount,
  hasLowLiquidityPrice,
  isPositiveAmount,
  pnlHistoryLine,
  pnlTone,
  splitDust,
  type PnlToken,
} from "../lib/qwakk-pnl-display";
import { TokenIcon } from "./TokenIcon";
import { useAssets } from "./useAssets";
import type { usePnl } from "./usePnl";

type Pnl = ReturnType<typeof usePnl>;
type Resolve = ReturnType<typeof useAssets>;

const TONE_CLASS = { up: "up", down: "down", flat: "" } as const;

/** A signed QOR figure. The sign carries the direction, color only repeats it. */
function SignedQor({ uqor }: { uqor: string }) {
  return <span className={`num ${TONE_CLASS[pnlTone(uqor)]}`}>{formatSignedQor(uqor)} QOR</span>;
}

/** A percent change pill: arrow and screen reader word as well as color. */
function PercentPill({ percent }: { percent: string | null }) {
  const change = formatPnlPercent(percent);
  if (!change) return null;
  return <span className={`change-pill${change.tone === "flat" ? "" : ` is-${change.tone}`}`}>
    {change.arrow && <span aria-hidden="true">{change.arrow}&nbsp;</span>}
    {change.word && <span className="sr-only">{change.word} </span>}
    {change.text}
  </span>;
}

function SummarySkeleton() {
  return <div className="pnl-summary" aria-hidden="true">
    {[0, 1, 2, 3].map((index) => <div key={index}><span className="pnl-skel is-label" /><span className="pnl-skel is-value" /><span className="pnl-skel is-sub" /></div>)}
  </div>;
}

function TokenRow({ token, resolve }: { token: PnlToken; resolve: Resolve }) {
  const asset = resolve(token.denom);
  const symbol = token.symbol ?? asset.symbol;
  const decimals = token.decimals ?? asset.decimals;
  const held = isPositiveAmount(token.held);
  const averageCost = formatQorPerToken(token.averageCostQor);
  const price = token.price ? formatQorPerToken(token.price.qorPerToken) : null;
  const unknownCost = isPositiveAmount(token.unknownCostAmount);
  const realizedUnknown = isPositiveAmount(token.realizedUnknownAmount);
  const outflow = isPositiveAmount(token.untrackedOutflowAmount);
  const amount = (value: string) => `${formatTokenAmount(value, decimals)} ${symbol}`;

  return <li className="pnl-row">
    <span className="cell-main pnl-token">
      <TokenIcon denom={token.denom} size="regular" />
      <span><b>{symbol}</b><small className="num">{held ? `${formatTokenAmount(token.held, decimals)} held` : "None held"}</small></span>
    </span>
    <span className="pnl-cell pnl-avg">
      <span className="pnl-label">Avg. buy price</span>
      {averageCost !== null ? <span className="num">{averageCost} QOR</span> : <span className="subtle">{held ? "Unknown" : "Nothing held"}</span>}
    </span>
    <span className="pnl-cell pnl-price">
      <span className="pnl-label">Price now</span>
      {price !== null
        ? <span className="num">{price} QOR{token.price?.lowLiquidity && <span className="low-tag">Small pool</span>}</span>
        : <span className="subtle">No QOR price yet</span>}
    </span>
    <span className="pnl-cell pnl-value">
      <span className="pnl-label">Value</span>
      {token.valueUqor !== null ? <span className="num">{formatQor(token.valueUqor)} QOR</span> : <span className="subtle">Not priced</span>}
    </span>
    <span className="pnl-cell pnl-unrealized">
      <span className="pnl-label">On what you hold</span>
      {token.unrealizedPnlUqor !== null
        ? <span className="pnl-change"><SignedQor uqor={token.unrealizedPnlUqor} /><PercentPill percent={token.unrealizedPnlPercent} /></span>
        : <span className="subtle">{!held ? "Nothing left" : token.price ? "Buy price unknown" : "Not counted"}</span>}
    </span>
    <span className="pnl-cell pnl-realized">
      <span className="pnl-label">From sales</span>
      {token.sells > 0 || token.realizedPnlUqor !== "0" ? <SignedQor uqor={token.realizedPnlUqor} /> : <span className="subtle">No sales yet</span>}
    </span>
    {(unknownCost || realizedUnknown || outflow) && <span className="pnl-row-notes">
      {unknownCost && <span><Info size={13} aria-hidden="true" />{amount(token.unknownCostAmount)} has no known buy price (faucet, transfer or from before our history starts). Not counted as profit or loss.</span>}
      {realizedUnknown && <span><Info size={13} aria-hidden="true" />{amount(token.realizedUnknownAmount)} was sold without a known buy or sale price, so that part is left out of From sales.</span>}
      {outflow && <span><Info size={13} aria-hidden="true" />{amount(token.untrackedOutflowAmount)} left the wallet outside a swap (sent, added to a pool or paid as a fee). Not counted as a sale.</span>}
    </span>}
  </li>;
}

/**
 * Profit and loss of the connected wallet, in QOR, from its indexed swaps:
 * a summary, then one row per token. Gains and losses always carry a sign
 * or arrow, never color alone, and a holding without a known cost is shown
 * as such, never as profit.
 */
export function ProfitLoss({ pnl }: { pnl: Pnl }) {
  const [showSmall, setShowSmall] = useState(false);
  const { report, loading, error, reload } = pnl;
  const resolve = useAssets(report ? report.tokens.map((token) => token.denom) : []);
  const { main, dust } = splitDust(report?.tokens ?? []);
  const rows = showSmall ? [...main, ...dust] : main;
  const totals = report?.totals;
  const noSwaps = report !== null && report.swapsCounted === 0;
  const lowLiquidity = report ? hasLowLiquidityPrice(report.tokens) : false;

  return <section className="panel pnl" aria-labelledby="pnl-title" aria-busy={loading}>
    <div className="panel-head">
      <div>
        <span className="panel-title" id="pnl-title">Profit and loss</span>
        {report && <span className="cell-sub">{pnlHistoryLine(report.history)}</span>}
      </div>
      {loading && report && <span className="subtle">Refreshing…</span>}
    </div>

    {!report && error ? <div className="empty">
      <span className="empty-icon"><AlertTriangle size={18} /></span>
      <h3>{PNL_ERROR_COPY[error].title}</h3>
      <p>{PNL_ERROR_COPY[error].body}</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>Try again</button>
    </div>
      : !report ? <div className="pnl-loading">
        <span className="sr-only">Adding up your swaps…</span>
        <SummarySkeleton />
        <span className="row-skeleton" /><span className="row-skeleton" /><span className="row-skeleton" />
      </div>
      : noSwaps ? <div className="empty">
        <span className="empty-icon"><TrendingUp size={18} /></span>
        <h3>No swaps on record yet</h3>
        <p>We have no swaps from this wallet in our history. Your next swap and its profit or loss lands here. Tokens from the faucet or a transfer have no buy price, so they are not counted.</p>
      </div>
      : totals && <>
        {error && <div className="pnl-note" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <p>These numbers could not refresh just now.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>Try again</button>
        </div>}
        <dl className="pnl-summary">
          <div className="pnl-headline">
            <dt>On what you hold</dt>
            <dd className="pnl-change"><SignedQor uqor={totals.unrealizedPnlUqor} /><PercentPill percent={totals.unrealizedPnlPercent} /></dd>
            <dd className="cell-sub">Compared with your buy price</dd>
          </div>
          <div>
            <dt>From sales</dt>
            <dd><SignedQor uqor={totals.realizedPnlUqor} /></dd>
            <dd className="cell-sub">Locked in for good</dd>
          </div>
          <div>
            <dt>Value now</dt>
            <dd><span className="num">{formatQor(totals.valueUqor)} QOR</span></dd>
            <dd className="cell-sub">Everything with a pool price</dd>
          </div>
          <div>
            <dt>What you paid</dt>
            <dd><span className="num">{formatQor(totals.costBasisUqor)} QOR</span></dd>
            <dd className="cell-sub">For tokens you still hold</dd>
          </div>
        </dl>

        {totals.coverage !== "complete" && <div className="pnl-note">
          <Info size={15} aria-hidden="true" />
          <p>{totals.coverage === "none"
            ? "None of your tokens has a known buy price yet, so there is no profit or loss to show."
            : "Partial picture: some tokens have no known buy price or no QOR price yet, so they are left out of profit and loss. Value now still counts everything with a pool price."}
          {report.history.gap && " Some older swap history is missing, so tokens bought back then have no known buy price."}</p>
        </div>}
        {lowLiquidity && <div className="pnl-note is-caution">
          <AlertTriangle size={15} aria-hidden="true" />
          <p>Some prices come from small pools, so even one small trade can swing their value a lot.</p>
        </div>}

        <div className="pnl-table">
          <div className="pnl-row table-head" aria-hidden="true">
            <span>Token</span><span>Avg. buy price</span><span>Price now</span><span>Value</span><span>On what you hold</span><span>From sales</span>
          </div>
          {rows.length
            ? <ul>{rows.map((token) => <TokenRow key={token.denom} token={token} resolve={resolve} />)}</ul>
            : <p className="pnl-only-small">Only small balances here.</p>}
        </div>
        {dust.length > 0 && <div className="panel-toggle">
          <label className="check-toggle pnl-toggle"><input type="checkbox" checked={showSmall} onChange={(event) => setShowSmall(event.target.checked)} />Show small balances ({dust.length})</label>
        </div>}
      </>}

    {report && !noSwaps && <p className="panel-note">All figures in QOR at current pool prices, using your average buy price. Tokens with no known buy price never count as profit. {BRAND.name}&apos;s 0.10% interface fee is not included.</p>}
  </section>;
}
