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
    <span className="coin-avatar is-large"><TokenIcon denom={market.token_a} size="avatar" /><span className="coin-badge"><TokenIcon denom={market.token_b} size="small" /></span></span>
    <span className="pool-card-body">
      <span className="pool-card-name"><b>{market.token_a_symbol}/{market.token_b_symbol}</b><small className="mono">#{market.id}</small></span>
      <small className="pool-card-type">{market.pool_type.replace(/_/g, " ")}</small>
      <span className="pool-card-price num">{market.price_b_per_a === null ? "No trades yet" : `${formatDecimal(market.price_b_per_a)} ${market.token_b_symbol}`}</span>
      <span className="pool-card-meta">
        <span className={`num ${change === null ? "subtle" : change >= 0 ? "up" : "down"}`}>{change === null ? "No 24h change" : formatPercentChange(change)}</span>
        <span className="subtle num">{formatDecimal(swaps, 0)} {swaps === 1 ? "swap" : "swaps"} in 24h</span>
      </span>
      <span className="pool-card-foot num">{reserve(market.reserve_a, market.token_a_decimals, market.token_a_symbol)} · {reserve(market.reserve_b, market.token_b_decimals, market.token_b_symbol)}</span>
    </span>
  </Link>;
}
