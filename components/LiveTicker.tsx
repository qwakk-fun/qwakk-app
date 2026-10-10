"use client";

import Link from "next/link";
import { TokenIcon } from "./TokenIcon";
import { formatDecimal, formatPercentChange, marketChange, useMarkets } from "./useMarkets";
import { formatBlockHeight, useNetwork } from "./useNetwork";
import { useQorMarket } from "./useQorMarket";
import { formatChange, formatUsdPrice } from "../lib/qor-price";

/** Enough repeats that one half of the track is wider than a large screen. Copies are inert so links are read and focused once. */
const MIN_ITEMS_PER_HALF = 10;

/**
 * A scrolling strip of live numbers under the top bar: QOR/USD, the latest
 * QoreChain Diana block and every indexed pool. It only shows real values,
 * and pauses on hover or when the viewer prefers reduced motion.
 */
export function LiveTicker() {
  const qor = useQorMarket("1");
  const network = useNetwork(15_000);
  const { markets } = useMarkets(30_000);

  const items: React.ReactNode[] = [];
  if (qor.data) {
    const change = qor.data.change24h;
    items.push(<span className="ticker-item" key="qor">
      <TokenIcon denom="uqor" size="small" /><b>QOR</b>
      <span className="num">{formatUsdPrice(qor.data.price)}</span>
      <span className={change !== null && change < 0 ? "down" : "up"}>{formatChange(change)}</span>
    </span>);
  }
  if (network?.height) {
    items.push(<span className="ticker-item" key="block"><i className="live-dot" aria-hidden="true" /><span className="subtle">Block</span><span className="num">{formatBlockHeight(network.height)}</span></span>);
  }
  for (const market of markets) {
    const change = marketChange(market);
    items.push(<Link className="ticker-item" href={`/pools/${market.id}`} key={`pool-${market.id}`}>
      <span className="pair-icons"><TokenIcon denom={market.token_a} size="small" /><TokenIcon denom={market.token_b} size="small" /></span>
      <b>{market.token_a_symbol}/{market.token_b_symbol}</b>
      <span className="num">{market.price_b_per_a === null ? "No trades yet" : formatDecimal(market.price_b_per_a, 4)}</span>
      {change !== null && <span className={change >= 0 ? "up" : "down"}>{formatPercentChange(change)}</span>}
    </Link>);
  }

  if (!items.length) return <div className="ticker" aria-hidden="true"><span className="ticker-skeleton" /></div>;

  const repeats = Math.max(1, Math.ceil(MIN_ITEMS_PER_HALF / items.length));
  const half = Array.from({ length: repeats }, (_, round) => items.map((item, index) => <span className="ticker-cell" key={`${round}-${index}`} inert={round > 0}>{item}</span>));

  return <div className="ticker" role="region" aria-label="Live market numbers">
    <div className="ticker-track">
      <div className="ticker-half">{half}</div>
      <div className="ticker-half" inert>{half}</div>
    </div>
  </div>;
}
