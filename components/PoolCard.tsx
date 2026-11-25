import Link from "next/link";
import { FavoriteButton } from "./FavoriteButton";
import { TokenIcon } from "./TokenIcon";
import type { Favorites } from "./useFavorites";
import { formatDecimal, formatPercentChange, marketChange, type Market } from "./useMarkets";
import { REWARDS_TAG } from "../lib/qwakk-rewards-copy";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketReserves, marketSides, pairLabel } from "../lib/qwakk-market-view";

/**
 * A board card for one indexed pool, base token first. The card opens the
 * pool page; the star sits beside the link (a button never goes inside one).
 */
export function PoolCard({ market, favorites, href, rewards = false }: { market: Market; favorites: Favorites; href: string; rewards?: boolean }) {
  const { base, quote } = marketSides(market);
  const lowLiquidity = isLowLiquidity(market);
  const price = lowLiquidity ? null : marketPrice(market);
  const change = lowLiquidity ? null : marketChange(market);
  const reserves = marketReserves(market);
  const swaps = Number(market.transactions_24h) || 0;
  return <div className="pool-card-wrap">
    <Link className="pool-card" href={href}>
      <span className="coin-avatar is-large"><TokenIcon denom={base.denom} size="avatar" /><span className="coin-badge"><TokenIcon denom={quote.denom} size="small" /></span></span>
      <span className="pool-card-body">
        <span className="pool-card-name"><b>{pairLabel(market)}</b><small className="mono">#{market.id}</small></span>
        <small className="pool-card-type">{market.pool_type.replace(/_/g, " ")}{lowLiquidity && <span className="low-tag">Low liquidity</span>}{rewards && <span className="reward-tag">{REWARDS_TAG}</span>}</small>
        <span className="pool-card-price num">{lowLiquidity ? "Price not shown" : price === null ? "No trades yet" : `${formatQuotePrice(price)} ${quote.symbol}`}</span>
        <span className="pool-card-meta">
          <span className={`num ${change === null ? "subtle" : change >= 0 ? "up" : "down"}`}>{change === null ? "No 24h change" : formatPercentChange(change)}</span>
          <span className="subtle num">{formatDecimal(swaps, 0)} {swaps === 1 ? "swap" : "swaps"} in 24h</span>
        </span>
        <span className="pool-card-foot num">{reserves.base} · {reserves.quote}</span>
      </span>
    </Link>
    <FavoriteButton favorites={favorites} poolId={market.id} pair={pairLabel(market)} className="pool-card-fav" />
  </div>;
}
