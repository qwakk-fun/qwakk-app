"use client";

import Link from "next/link";
import { ArrowRight, Layers } from "lucide-react";
import { formatChange, formatUsdCompact, formatUsdPrice } from "../lib/qor-price";
import { PoolCard } from "./PoolCard";
import { Sparkline } from "./Sparkline";
import { TokenIcon } from "./TokenIcon";
import { useMarkets } from "./useMarkets";
import { formatBlockHeight, useNetwork } from "./useNetwork";
import { useQorMarket } from "./useQorMarket";

/** How many pools the landing board shows before linking to the full list. */
const BOARD_SIZE = 6;

/** Live QOR market card for the landing hero. */
export function TickerCard() {
  const { data, status } = useQorMarket("7");
  const change = data?.change24h ?? null;

  return <aside className="coin-card" aria-label="QOR market">
    <div className="coin-card-head">
      <TokenIcon denom="uqor" size="large" />
      <div>
        <b>QOR</b>
        <span className="subtle">QoreChain native coin</span>
      </div>
      <span className="tag"><i className={`live-dot ${data ? "" : "is-idle"}`} aria-hidden="true" />7D</span>
    </div>
    <div className="coin-card-price">
      <strong className="num">{data ? formatUsdPrice(data.price) : status === "unavailable" ? "Not available" : "Loading…"}</strong>
      {data && <span className={`change-pill ${change !== null && change < 0 ? "is-down" : "is-up"}`}>{formatChange(change)}</span>}
    </div>
    <Sparkline points={data?.points ?? []} height={88} />
    <div className="coin-card-stats">
      <div><span className="stat-label">24h volume</span><span className="stat-value num">{formatUsdCompact(data?.volume24h ?? null)}</span></div>
      <div><span className="stat-label">Market cap</span><span className="stat-value num">{formatUsdCompact(data?.marketCap ?? null)}</span></div>
    </div>
    <p className="coin-card-source">QOR across exchanges, from CoinGecko.</p>
  </aside>;
}

/** Real network numbers under the hero. */
export function StatsStrip() {
  const network = useNetwork();
  const { data } = useQorMarket("1");

  return <section className="stats-strip" aria-label="Network at a glance">
    <div><span className="stat-label">QoreChain Diana block</span><strong className="num">{network ? formatBlockHeight(network.height) : "…"}</strong></div>
    <div><span className="stat-label">Native AMM pools</span><strong className="num">{network ? network.pools : "…"}</strong></div>
    <div><span className="stat-label">QOR price</span><strong className="num">{data ? formatUsdPrice(data.price) : "…"}</strong></div>
    <div><span className="stat-label">QOR market cap</span><strong className="num">{data ? formatUsdCompact(data.marketCap) : "…"}</strong></div>
  </section>;
}

/** The busiest indexed pools as a board of cards. */
export function PoolBoard() {
  const { markets, state } = useMarkets();
  const busiest = [...markets].sort((a, b) => (Number(b.transactions_24h) || 0) - (Number(a.transactions_24h) || 0)).slice(0, BOARD_SIZE);

  if (state === "loading") return <div className="pool-grid" aria-busy="true">{Array.from({ length: 3 }, (_, index) => <span className="pool-card is-skeleton" key={index} />)}</div>;
  if (state === "unavailable") return <div className="panel empty"><h3>Pool data is temporarily unavailable</h3><p>The market indexer could not be reached. This board retries on its own.</p></div>;
  if (!busiest.length) return <div className="panel empty"><span className="empty-icon"><Layers size={18} /></span><h3>No pools are open yet</h3><p>The first native AMM pool on QoreChain Diana will appear here with its price and activity.</p></div>;

  return <>
    <div className="pool-grid">{busiest.map((market) => <PoolCard market={market} key={market.id} />)}</div>
    {markets.length > BOARD_SIZE && <Link className="board-more" href="/pools">See all {markets.length} pools <ArrowRight size={15} /></Link>}
  </>;
}
