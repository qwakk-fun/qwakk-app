"use client";

import Link from "next/link";
import { FavoriteButton } from "./FavoriteButton";
import { Sparkline } from "./Sparkline";
import { TokenIcon } from "./TokenIcon";
import type { Favorites } from "./useFavorites";
import type { Market } from "./useMarkets";
import type { PoolSpark } from "./usePoolSparks";
import { REWARDS_TAG } from "../lib/qwakk-rewards-copy";
import { isLowLiquidity, marketChange, marketPrice, marketSides, marketVolume, pairLabel } from "../lib/qwakk-market-view";
import { changeBadge, formatCompactAmount, formatListPrice } from "../lib/qwakk-pools-list";

/** Same floor as the pool chart: a move under 2% stays a gentle line. */
const SPARK_MIN_SPAN = 0.02;

/** Column labels over the rows. Each row's link already reads out every value, so this stays visual. */
export function PoolsHead() {
  return <div className="pf-row pools-row pf-head" aria-hidden="true">
    <span>Pool</span><span>Price</span><span>24h change</span><span className="pools-col-trend">Trend</span><span className="pools-col-wide">Swaps 24h</span><span className="pools-col-wide">Liquidity</span>
  </div>;
}

/**
 * One pool: pair, price, 24h change, trend line, activity and pool value. The
 * row opens the pool page; the star sits beside the link, never inside it.
 */
export function PoolRow({ market, favorites, href, rewards, spark }: { market: Market; favorites: Favorites; href: string; rewards: boolean; spark: PoolSpark | undefined }) {
  const { base, quote } = marketSides(market);
  const lowLiquidity = isLowLiquidity(market);
  const price = lowLiquidity ? null : marketPrice(market);
  const change = lowLiquidity ? null : changeBadge(marketChange(market));
  const swaps = Number(market.transactions_24h) || 0;
  const volume = marketVolume(market);
  const volumeText = formatCompactAmount(volume.value);
  const liquidity = formatCompactAmount(market.tvl_quote);
  // A low-liquidity price is not meaningful, so it is not drawn either.
  const points = lowLiquidity ? [] : spark?.summary?.points ?? [];
  // "No trades" only when the read landed and the pool truly had none in the window.
  const quiet = !lowLiquidity && spark?.state === "ready" && spark.summary?.traded === false;
  const swapsText = swaps === 0 ? "No swaps" : `${swaps.toLocaleString("en-US")} ${swaps === 1 ? "swap" : "swaps"}`;
  return <li className={`pools-item${lowLiquidity ? " is-low" : ""}`}>
    <Link className="pf-row pools-row" href={href}>
      <span className="cell-main pools-pool">
        <span className="pair-icons"><TokenIcon denom={base.denom} size="regular" /><TokenIcon denom={quote.denom} size="regular" /></span>
        <span className="pools-name">
          <b>{pairLabel(market, " / ")}</b>
          <small>
            <span className="num">#{market.id}</span>
            {market.pool_type !== "constant_product" && <span className="pools-type">{market.pool_type.replace(/_/g, " ")}</span>}
            <span className="pools-swaps-sm num">{swapsText}</span>
            {lowLiquidity && <span className="low-tag">Low liquidity</span>}
            {rewards && <span className="reward-tag">{REWARDS_TAG}</span>}
          </small>
        </span>
      </span>
      <span className="pools-price num">
        {lowLiquidity ? <span className="subtle">Not shown</span> : price === null ? <span className="subtle">No trades yet</span> : <>{formatListPrice(price)}<small>{quote.symbol}</small></>}
      </span>
      <span className="pools-change">
        {change
          ? <span className={`change-pill${change.tone === "flat" ? "" : ` is-${change.tone}`}`}>{change.arrow && <span aria-hidden="true">{change.arrow}&nbsp;</span>}{change.word && <span className="sr-only">{change.word} </span>}{change.text}</span>
          : !lowLiquidity && <span className="subtle">No 24h data</span>}
      </span>
      <span className="pools-col-trend pools-spark">{points.length > 1
        ? <Sparkline points={points} width={120} height={32} minSpan={SPARK_MIN_SPAN} />
        : quiet ? <small className="subtle">No trades</small> : null}</span>
      <span className="pools-col-wide pools-stack num">
        <b className={swaps === 0 ? "subtle" : undefined}>{swapsText}</b>
        {swaps > 0 && volumeText && <small><span className="sr-only">volume </span>{volumeText} {volume.symbol}</small>}
      </span>
      <span className="pools-col-wide pools-stack num">
        <span className="sr-only">liquidity </span>{liquidity ? <b>{liquidity} <small>{quote.symbol}</small></b> : <b className="subtle">Unknown</b>}
      </span>
    </Link>
    <FavoriteButton favorites={favorites} poolId={market.id} pair={pairLabel(market)} />
  </li>;
}

/** A starred pool the indexer no longer lists. It stays until the visitor removes its star. */
export function MissingPoolRow({ poolId, favorites }: { poolId: string; favorites: Favorites }) {
  return <li className="pools-item is-missing">
    <span className="pf-row pools-row">
      <span className="cell-main pools-pool"><span className="pools-name"><b>Pool #{poolId}</b><small>Not in the pool list right now</small></span></span>
    </span>
    <FavoriteButton favorites={favorites} poolId={poolId} pair={`pool #${poolId}`} />
  </li>;
}

/** Row-shaped placeholders, so the list does not jump when the pools arrive. */
export function PoolsSkeleton({ count = 5 }: { count?: number }) {
  return <div className="pf-skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <span key={index} className="pf-skel-row"><i className="is-dot" /><i className="is-line" /><i className="is-end" /></span>)}
  </div>;
}
