"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Activity, ArrowRight, ArrowUpRight, Eye, Flame, KeyRound, Layers, ShieldCheck, Trophy } from "lucide-react";
import { Identicon } from "./Identicon";
import { PriceChart } from "./PriceChart";
import { TokenIcon } from "./TokenIcon";
import { describeTrade, shortWallet, timeAgo, tradeQorVolume, useActivity, type Trade } from "./useActivity";
import { formatDecimal, formatPercentChange, marketChange, useMarkets, type Market } from "./useMarkets";
import { formatBlockHeight, useNetwork } from "./useNetwork";
import { useQorMarket } from "./useQorMarket";
import { BRAND } from "../lib/brand";
import { MARKET_RANGE_LABELS, formatChange, formatUsdCompact, formatUsdPrice, type MarketRange } from "../lib/qor-price";

type ColumnId = "trending" | "trades" | "traders" | "qor";

const COLUMNS: Array<{ id: ColumnId; label: string }> = [
  { id: "trending", label: "Trending" },
  { id: "trades", label: "Live trades" },
  { id: "traders", label: "Top traders" },
  { id: "qor", label: "QOR" },
];

/** Pools with the most swaps in 24h get a hot tag, up to this many. */
const HOT_COUNT = 3;
const CHART_RANGES: MarketRange[] = ["1", "7", "30"];

/** Re-renders relative times ("12s ago") on a steady beat. Zero until mounted. */
function useNow(stepMs = 10_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [stepMs]);
  return now;
}

function Column({ id, icon, title, meta, active, children }: { id: ColumnId; icon: ReactNode; title: string; meta?: ReactNode; active: boolean; children: ReactNode }) {
  return <section className={`board-col ${active ? "is-active" : ""}`} aria-labelledby={`col-${id}`}>
    <header className="col-head">
      <span className="col-icon" aria-hidden="true">{icon}</span>
      <h2 id={`col-${id}`}>{title}</h2>
      {meta && <span className="col-meta">{meta}</span>}
    </header>
    <div className="col-body">{children}</div>
  </section>;
}

function Tabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return <div className="tabs" role="group" aria-label={label}>
    {options.map((option) => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function ColumnNote({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="col-note">{icon && <span className="col-note-icon">{icon}</span>}<b>{title}</b>{children && <p>{children}</p>}</div>;
}

function SkeletonRows({ count = 6, tall = false }: { count?: number; tall?: boolean }) {
  return <div aria-busy="true">{Array.from({ length: count }, (_, index) => <span className={`row-skeleton ${tall ? "is-tall" : ""}`} key={index} />)}</div>;
}

type TrendSort = "hot" | "gainers" | "newest";

function sortTrending(markets: Market[], sort: TrendSort) {
  const sorted = [...markets];
  if (sort === "newest") return sorted.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  if (sort === "gainers") return sorted.sort((a, b) => (marketChange(b) ?? -Infinity) - (marketChange(a) ?? -Infinity));
  return sorted.sort((a, b) => (Number(b.transactions_24h) || 0) - (Number(a.transactions_24h) || 0));
}

function TrendingColumn({ active }: { active: boolean }) {
  const { markets, state } = useMarkets();
  const [sort, setSort] = useState<TrendSort>("hot");
  const rows = useMemo(() => sortTrending(markets, sort), [markets, sort]);
  const hot = useMemo(() => new Set(sortTrending(markets, "hot").filter((market) => Number(market.transactions_24h) > 0).slice(0, HOT_COUNT).map((market) => String(market.id))), [markets]);

  return <Column id="trending" icon={<Flame size={16} />} title="Trending" meta={<Link className="col-link" href="/pools">All pools <ArrowUpRight size={13} /></Link>} active={active}>
    <div className="col-toolbar">
      <Tabs label="Sort pools" value={sort} onChange={setSort} options={[{ value: "hot", label: "Hot" }, { value: "gainers", label: "Gainers" }, { value: "newest", label: "Newest" }]} />
    </div>
    {state === "loading" ? <SkeletonRows />
      : state === "unavailable" ? <ColumnNote title="Pool data is temporarily unavailable">This column retries on its own.</ColumnNote>
      : !rows.length ? <ColumnNote icon={<Layers size={18} />} title="No pools are open yet">The first native AMM pool on QoreChain Diana will appear here.</ColumnNote>
      : <ol className="coin-list">{rows.map((market) => {
        const change = marketChange(market);
        const swaps = Number(market.transactions_24h) || 0;
        return <li key={market.id}>
          <Link className="coin-row" href={`/pools/${market.id}`}>
            <span className="coin-avatar"><TokenIcon denom={market.token_a} size="avatar" /><span className="coin-badge"><TokenIcon denom={market.token_b} size="small" /></span></span>
            <span className="coin-main">
              <span className="coin-name"><b>{market.token_a_symbol}/{market.token_b_symbol}</b>{hot.has(String(market.id)) && <span className="hot-tag">Hot</span>}</span>
              <span className="coin-sub num">{market.price_b_per_a === null ? "No trades yet" : `${formatDecimal(market.price_b_per_a, 6)} ${market.token_b_symbol}`}</span>
            </span>
            <span className="coin-side">
              <b className="num">{market.volume_qor_24h !== null && Number(market.volume_qor_24h) > 0 ? `${formatDecimal(market.volume_qor_24h, 2)} QOR` : `${formatDecimal(swaps, 0)} ${swaps === 1 ? "swap" : "swaps"}`}</b>
              <span className={`num ${change === null ? "subtle" : change >= 0 ? "up" : "down"}`}>{change === null ? "No 24h change" : formatPercentChange(change)}</span>
            </span>
          </Link>
        </li>;
      })}</ol>}
  </Column>;
}

function TradeCard({ trade, now }: { trade: Trade; now: number }) {
  const { side, baseSymbol, paid, received } = describeTrade(trade);
  const quoteSymbol = side === "buy" ? (trade.denom_in === trade.token_b ? trade.token_b_symbol : trade.token_a_symbol) : (trade.denom_out === trade.token_b ? trade.token_b_symbol : trade.token_a_symbol);
  return <article className="feed-item">
    <Identicon address={trade.sender} size={36} />
    <div className="feed-body">
      <div className="feed-head">
        <b className="mono">{shortWallet(trade.sender)}</b>
        <span className="subtle">{now ? timeAgo(trade.executed_at, now) : ""}</span>
        <a className="feed-tx" href={`https://explore.qore.network/tx/${trade.tx_hash}`} target="_blank" rel="noreferrer" aria-label="Open transaction in the QoreChain explorer"><ArrowUpRight size={15} /></a>
      </div>
      <p className="feed-text"><span className={side === "buy" ? "side-buy" : "side-sell"}>{side === "buy" ? "Bought" : "Sold"}</span> {baseSymbol} {side === "buy" ? "with" : "for"} {quoteSymbol}</p>
      <Link className="feed-card" href={`/pools/${trade.pool_id}`}>
        <span className="pair-icons"><TokenIcon denom={trade.token_a} size="regular" /><TokenIcon denom={trade.token_b} size="regular" /></span>
        <span className="feed-card-name"><b>{trade.token_a_symbol}/{trade.token_b_symbol}</b><small>Pool #{trade.pool_id}</small></span>
        <span className="feed-figs">
          <span><small>Paid</small><b className="num">{paid}</b></span>
          <span><small>Received</small><b className={`num ${side === "buy" ? "up" : "down"}`}>{received}</b></span>
        </span>
      </Link>
    </div>
  </article>;
}

function TradesColumn({ active, activity, now }: { active: boolean; activity: ReturnType<typeof useActivity>; now: number }) {
  const { trades, state } = activity;
  return <Column id="trades" icon={<Activity size={16} />} title="Live trades" meta={<span className="col-live"><i className={`live-dot ${state === "ready" ? "" : "is-idle"}`} aria-hidden="true" />Live</span>} active={active}>
    {state === "loading" ? <SkeletonRows count={4} tall />
      : state === "unavailable" ? <ColumnNote title="Trades are temporarily unavailable">The market indexer could not be reached. This feed retries on its own.</ColumnNote>
      : !trades.length ? <ColumnNote icon={<Activity size={18} />} title="No swaps yet">Every swap on a QoreChain Diana pool shows up here within seconds.</ColumnNote>
      : <div className="feed">{trades.map((trade) => <TradeCard trade={trade} now={now} key={`${trade.tx_hash}-${trade.executed_at}-${trade.pool_id}`} />)}</div>}
  </Column>;
}

type TraderSort = "volume" | "swaps";

function TradersColumn({ active, activity }: { active: boolean; activity: ReturnType<typeof useActivity> }) {
  const { trades, state } = activity;
  const [sort, setSort] = useState<TraderSort>("volume");
  const traders = useMemo(() => {
    const totals = new Map<string, { address: string; swaps: number; volume: number }>();
    for (const trade of trades) {
      if (!trade.sender) continue;
      const entry = totals.get(trade.sender) ?? { address: trade.sender, swaps: 0, volume: 0 };
      entry.swaps += 1;
      entry.volume += tradeQorVolume(trade) ?? 0;
      totals.set(trade.sender, entry);
    }
    return [...totals.values()].sort((a, b) => sort === "volume" ? b.volume - a.volume || b.swaps - a.swaps : b.swaps - a.swaps || b.volume - a.volume);
  }, [trades, sort]);

  return <Column id="traders" icon={<Trophy size={16} />} title="Top traders" active={active}>
    <div className="col-toolbar">
      <Tabs label="Rank traders by" value={sort} onChange={setSort} options={[{ value: "volume", label: "QOR volume" }, { value: "swaps", label: "Swaps" }]} />
    </div>
    {state === "loading" ? <SkeletonRows />
      : state === "unavailable" ? <ColumnNote title="Rankings are temporarily unavailable">This column retries on its own.</ColumnNote>
      : !traders.length ? <ColumnNote icon={<Trophy size={18} />} title="No traders ranked yet">Wallets appear here as soon as they swap on QoreChain Diana.</ColumnNote>
      : <>
        <ol className="rank-list">{traders.map((trader, index) => <li className="rank-row" key={trader.address}>
          <span className="rank-num num">{index + 1}</span>
          <Identicon address={trader.address} size={30} />
          <span className="rank-name mono" title={trader.address}>{shortWallet(trader.address)}</span>
          <span className="rank-value">
            <b className="num up">{sort === "volume" ? `${formatDecimal(trader.volume, 2)} QOR` : `${trader.swaps} ${trader.swaps === 1 ? "swap" : "swaps"}`}</b>
            <small className="num">{sort === "volume" ? `${trader.swaps} ${trader.swaps === 1 ? "swap" : "swaps"}` : `${formatDecimal(trader.volume, 2)} QOR`}</small>
          </span>
        </li>)}</ol>
        <p className="col-foot">Ranked from the latest indexed swaps.</p>
      </>}
  </Column>;
}

function QorColumn({ active }: { active: boolean }) {
  const [range, setRange] = useState<MarketRange>("1");
  const market = useQorMarket(range);
  const network = useNetwork();
  const data = market.data;
  const change = data?.change24h ?? null;

  return <Column id="qor" icon={<TokenIcon denom="uqor" size="small" />} title="QOR market" meta={<span className="col-meta-text">CoinGecko</span>} active={active}>
    <div className="qor-card">
      <div className="qor-head">
        <TokenIcon denom="uqor" size="avatar" />
        <div><b>QOR</b><span className="subtle">QoreChain native coin</span></div>
      </div>
      <div className="qor-price">
        <strong className="num">{data ? formatUsdPrice(data.price) : market.status === "unavailable" ? "Not available" : "…"}</strong>
        {data && <span className={`change-pill ${change !== null && change < 0 ? "is-down" : "is-up"}`}>{formatChange(change)}</span>}
      </div>
      <Tabs label="Chart range" value={range} onChange={setRange} options={CHART_RANGES.map((value) => ({ value, label: MARKET_RANGE_LABELS[value] }))} />
      {data && data.points.length > 1
        ? <PriceChart points={data.points} dimmed={market.status === "refreshing"} height={190} />
        : <div className="chart-empty" style={{ height: 190 }}>{market.status === "unavailable" ? "QOR market data is temporarily unavailable." : "Loading QOR market data…"}</div>}
      <dl className="qor-stats">
        <div><dt>24h volume</dt><dd className="num">{formatUsdCompact(data?.volume24h ?? null)}</dd></div>
        <div><dt>Market cap</dt><dd className="num">{formatUsdCompact(data?.marketCap ?? null)}</dd></div>
        <div><dt>Diana block</dt><dd className="num">{network ? formatBlockHeight(network.height) : "…"}</dd></div>
        <div><dt>Native pools</dt><dd className="num">{network ? network.pools : "…"}</dd></div>
      </dl>
    </div>
    <div className="pitch">
      <h3>{BRAND.tagline}</h3>
      <p>{BRAND.name} is a fast, non-custodial exchange for the QoreChain native network. Your keys never leave your wallet.</p>
      <ul className="pitch-points">
        <li><KeyRound size={14} />Non-custodial</li>
        <li><ShieldCheck size={14} />Quantum-safe network</li>
        <li><Eye size={14} />Fees shown up front</li>
      </ul>
      <Link className="btn btn-primary btn-block" href="/swap">Open the trade screen <ArrowRight size={16} /></Link>
    </div>
  </Column>;
}

/** The home board: pump-style live columns side by side, one at a time on phones. */
export function Board() {
  const [active, setActive] = useState<ColumnId>("trending");
  const activity = useActivity();
  const now = useNow();

  return <>
    <h1 className="sr-only">{BRAND.name}: {BRAND.tagline}</h1>
    <div className="board-switch" role="group" aria-label="Board columns">
      {COLUMNS.map((column) => <button type="button" key={column.id} aria-pressed={active === column.id} onClick={() => setActive(column.id)}>{column.label}</button>)}
    </div>
    <div className="board">
      <TrendingColumn active={active === "trending"} />
      <TradesColumn active={active === "trades"} activity={activity} now={now} />
      <TradersColumn active={active === "traders"} activity={activity} />
      <QorColumn active={active === "qor"} />
    </div>
  </>;
}
