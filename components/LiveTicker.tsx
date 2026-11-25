"use client";

import Link from "next/link";
import { Identicon } from "./Identicon";
import { TokenIcon } from "./TokenIcon";
import { describeTrade, shortWallet, useActivity } from "./useActivity";
import { formatPercentChange, marketChange, useMarkets } from "./useMarkets";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketSides, pairLabel } from "../lib/qwakk-market-view";
import { useQorMarket } from "./useQorMarket";
import { formatChange, formatUsdPrice } from "../lib/qor-price";
import { marketPairSlugs, poolPath } from "../lib/qwakk-pair-slug";

/** Enough repeats that one half of the track is wider than a large screen. Copies are inert so links are read and focused once. */
const MIN_ITEMS_PER_HALF = 12;
const TRADE_LIMIT = 16;

/**
 * A scrolling strip under the top bar: the latest swaps by wallet, then QOR/USD
 * and every indexed pool. It only shows real values, and pauses on hover or
 * when the viewer prefers reduced motion.
 */
export function LiveTicker() {
  const qor = useQorMarket("1");
  const { markets } = useMarkets(30_000);
  const { trades } = useActivity(20_000);

  const slugs = marketPairSlugs(markets);
  const quoteSides = new Map(markets.map((market) => [String(market.id), market.quote_side ?? null]));
  const items: React.ReactNode[] = [];
  for (const trade of trades.slice(0, TRADE_LIMIT)) {
    const { side, base } = describeTrade(trade, quoteSides.get(String(trade.pool_id)) ?? null);
    items.push(<Link className="ticker-item" href={poolPath(trade.pool_id, slugs)} key={`trade-${trade.tx_hash}-${trade.executed_at}`}>
      <Identicon address={trade.sender} size={18} />
      <b>{shortWallet(trade.sender)}</b>
      <span className={side === "buy" ? "up" : "down"}>{side === "buy" ? "bought" : "sold"} {base}</span>
    </Link>);
  }
  if (qor.data) {
    const change = qor.data.change24h;
    items.push(<span className="ticker-item" key="qor">
      <TokenIcon denom="uqor" size="small" /><b>QOR</b>
      <span className="num">{formatUsdPrice(qor.data.price)}</span>
      <span className={change !== null && change < 0 ? "down" : "up"}>{formatChange(change)}</span>
    </span>);
  }
  // Low-liquidity pools have no reliable price, so they stay off the strip.
  for (const market of markets.filter((entry) => !isLowLiquidity(entry))) {
    const change = marketChange(market);
    const price = marketPrice(market);
    const { base, quote } = marketSides(market);
    items.push(<Link className="ticker-item" href={poolPath(market.id, slugs)} key={`pool-${market.id}`}>
      <span className="pair-icons"><TokenIcon denom={base.denom} size="small" /><TokenIcon denom={quote.denom} size="small" /></span>
      <b>{pairLabel(market)}</b>
      <span className="num">{price === null ? "No trades yet" : `${formatQuotePrice(price)} ${quote.symbol}`}</span>
      {change !== null && <span className={change >= 0 ? "up" : "down"}>{formatPercentChange(change)}</span>}
    </Link>);
  }

  if (!items.length) return <div className="ticker" aria-hidden="true"><span className="ticker-skeleton" /></div>;

  const repeats = Math.max(1, Math.ceil(MIN_ITEMS_PER_HALF / items.length));
  const half = Array.from({ length: repeats }, (_, round) => items.map((item, index) => <span className="ticker-cell" key={`${round}-${index}`} inert={round > 0}>{item}</span>));

  return <div className="ticker" role="region" aria-label="Live trades and prices">
    <div className="ticker-track">
      <div className="ticker-half">{half}</div>
      <div className="ticker-half" inert>{half}</div>
    </div>
  </div>;
}
