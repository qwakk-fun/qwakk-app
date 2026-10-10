import Link from "next/link";
import { TokenIcon } from "./TokenIcon";
import { formatDecimal, formatPercentChange, marketChange, type Market } from "./useMarkets";
import { formatBaseAmount } from "../lib/qora-assets";

function reserve(value: string, decimals: string | number, symbol: string) {
  return `${formatBaseAmount(value ?? "0", Number(decimals), 4)} ${symbol}`;
}

/** A board card for one indexed pool. The whole card opens the pool page. */
export function PoolCard({ market }: { market: Market }) {
  const change = marketChange(market);
  const swaps = Number(market.transactions_24h) || 0;
  return <Link className="pool-card" href={`/pools/${market.id}`}>
    <span className="pool-card-top">
      <span className="pair-icons"><TokenIcon denom={market.token_a} size="large" /><TokenIcon denom={market.token_b} size="large" /></span>
      <span className="tag mono">#{market.id}</span>
    </span>
    <span className="pool-card-name">
      <b>{market.token_a_symbol} / {market.token_b_symbol}</b>
      <small>{market.pool_type.replace(/_/g, " ")}</small>
    </span>
    <span className="pool-card-price">
      <strong className="num">{market.price_b_per_a === null ? "No trades yet" : formatDecimal(market.price_b_per_a)}</strong>
      <small>{market.token_b_symbol} per {market.token_a_symbol}</small>
    </span>
    <span className="pool-card-meta">
      <span className={`change-pill ${change === null ? "" : change >= 0 ? "is-up" : "is-down"}`}>{change === null ? "No 24h change" : formatPercentChange(change)}</span>
      <span className="subtle num">{formatDecimal(swaps, 0)} {swaps === 1 ? "swap" : "swaps"} in 24h</span>
    </span>
    <span className="pool-card-foot num">
      <span>{reserve(market.reserve_a, market.token_a_decimals, market.token_a_symbol)}</span>
      <span>{reserve(market.reserve_b, market.token_b_decimals, market.token_b_symbol)}</span>
    </span>
  </Link>;
}
