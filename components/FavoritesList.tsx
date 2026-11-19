"use client";

import Link from "next/link";
import { FavoriteButton } from "./FavoriteButton";
import { Sparkline } from "./Sparkline";
import { TokenIcon } from "./TokenIcon";
import type { Favorites } from "./useFavorites";
import { formatPercentChange, marketChange, type Market } from "./useMarkets";
import { usePoolSparks, type PoolSpark } from "./usePoolSparks";
import { formatQuotePrice, isLowLiquidity, marketPrice, marketSides, pairLabel } from "../lib/qwakk-market-view";

/** Same floor as the pool chart: a move under 2% stays a gentle line. */
const SPARK_MIN_SPAN = 0.02;

function WatchRow({ market, favorites, spark }: { market: Market; favorites: Favorites; spark: PoolSpark | undefined }) {
  const { base, quote } = marketSides(market);
  const lowLiquidity = isLowLiquidity(market);
  const price = lowLiquidity ? null : marketPrice(market);
  const change = lowLiquidity ? null : marketChange(market);
  // A low-liquidity price is not meaningful, so it is not drawn either.
  const points = lowLiquidity ? [] : spark?.summary?.points ?? [];
  // "No trades" only when the read landed and the pool truly had none in the window; otherwise nothing is claimed.
  const quiet = !lowLiquidity && spark?.state === "ready" && spark.summary?.traded === false;
  return <li className="watch-row">
    <Link className="watch-link" href={`/pools/${market.id}`}>
      <span className="cell-main"><span className="pair-icons"><TokenIcon denom={base.denom} size="regular" /><TokenIcon denom={quote.denom} size="regular" /></span><span><b>{pairLabel(market, " / ")}</b><small>#{market.id}{lowLiquidity && <span className="low-tag">Low liquidity</span>}</small></span></span>
      <span className="watch-spark">{points.length > 1
        ? <Sparkline points={points} width={160} height={36} minSpan={SPARK_MIN_SPAN} />
        : quiet ? <small className="subtle">No trades in 24h</small> : null}</span>
      <span className="watch-price num">
        <b>{lowLiquidity ? "Not shown" : price === null ? "No trades yet" : `${formatQuotePrice(price)} ${quote.symbol}`}</b>
        <small className={change === null ? "subtle" : change >= 0 ? "up" : "down"}>{change === null ? "No 24h change" : `${formatPercentChange(change)} 24h`}</small>
      </span>
    </Link>
    <FavoriteButton favorites={favorites} poolId={market.id} pair={pairLabel(market)} />
  </li>;
}

/** A starred pool the indexer no longer lists. It stays until the visitor removes it. */
function MissingRow({ poolId, favorites }: { poolId: string; favorites: Favorites }) {
  return <li className="watch-row is-missing">
    <span className="watch-link">
      <span className="cell-main"><span><b>Pool #{poolId}</b><small>Not in the pool list right now</small></span></span>
    </span>
    <FavoriteButton favorites={favorites} poolId={poolId} pair={`pool #${poolId}`} />
  </li>;
}

/**
 * The Favorites view of the pools page: each starred pool with its price, 24h
 * change and a 24 hour sparkline, newest star first (`ids`, already filtered
 * by any search). Stars live in this browser only (lib/qwakk-favorites.ts).
 */
export function FavoritesList({ ids, markets, favorites, ready, label }: { ids: readonly string[]; markets: Market[]; favorites: Favorites; ready: boolean; label: string }) {
  const byId = new Map(markets.map((market) => [String(market.id), market]));
  // One batched read for every listed pool that is not low liquidity.
  const sparks = usePoolSparks(ids.filter((id) => { const market = byId.get(id); return market !== undefined && !isLowLiquidity(market); }));
  return <section className="panel watchlist" aria-label={label}>
    <ul className="watch-list">
      {ids.map((id) => {
        const market = byId.get(id);
        if (market) return <WatchRow key={id} market={market} favorites={favorites} spark={sparks[id]} />;
        // Until the pool list has loaded, an unknown id is not yet "missing".
        return ready ? <MissingRow key={id} poolId={id} favorites={favorites} /> : <li className="watch-row" key={id} aria-hidden="true"><span className="row-skeleton" /></li>;
      })}
    </ul>
  </section>;
}
