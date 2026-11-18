"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, PauseCircle } from "lucide-react";
import { LiquidityPanel } from "./LiquidityPanel";
import { QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { useFeatures } from "./useFeatures";
import { useNetworkCopy } from "./NetworkContext";
import { ChartIntervalTabs } from "./ChartIntervalTabs";
import { ChartMessage, PoolChart, type PoolCandle } from "./PoolChart";
import { RecentSwaps, shortAddress, type PoolSwap } from "./RecentSwaps";
import { formatBaseAmount, withAssetOverrides } from "../lib/qwakk-assets";
import { BRAND } from "../lib/brand";
import { CHART_INTERVAL_LABELS, chartEmptyCopy, type ChartInterval } from "../lib/qwakk-chart";
import { QUOTE_BLOCK_COPY } from "../lib/qwakk-tx-copy";
import { formatQuotePrice, isLowLiquidity, lowLiquidityCopy, marketPrice, marketReserves, marketSides, marketVolume, pairLabel, priceUnit, type QuoteMarket } from "../lib/qwakk-market-view";

type Pool = QuoteMarket & {
  id: string | number;
  pool_type: string;
  status: string;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_name: string | null;
  token_b_name: string | null;
  token_a_decimals: string | number | null;
  token_b_decimals: string | number | null;
  reserve_a: string;
  reserve_b: string;
  lp_supply?: string | null;
  creator?: string | null;
  created_height?: string | number | null;
};

/** QoreChain AMM params report lp_token_decimals = 6 on Diana and mainnet. */
const LP_TOKEN_DECIMALS = 6;

/** `quote_candles` are already in quote per base; the raw `candles` are not used. `interval` is the one these candles are for. */
type Detail = { pool: Pool; quote_candles?: PoolCandle[]; swaps: PoolSwap[]; interval: ChartInterval };

export function PoolDetailView({ poolId }: { poolId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unavailable">("loading");
  // Same default as the swap page: 1m candles on a quiet pool are mostly empty.
  const [chartInterval, setChartInterval] = useState<ChartInterval>("1h");
  // Each wallet action has its own switch (QWAKK_NATIVE_ACTIONS). The liquidity
  // panel shows only the parts whose switch is on (remove-only is a valid mode).
  const { actions } = useFeatures();
  const { copy } = useNetworkCopy();
  const nativeActions = actions.swap;
  const liquidityActions = actions.add_liquidity || actions.remove_liquidity;
  const [walletAddress, setWalletAddress] = useState("");

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qwakk-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qwakk:wallet-change", restoreWallet);
    return () => window.removeEventListener("qwakk:wallet-change", restoreWallet);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/pools/${poolId}?interval=${chartInterval}`, { cache: "no-store" });
        if (response.status === 404) throw new Error("missing");
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json() as Omit<Detail, "interval">;
        // Curated symbols and decimals win over the indexed token record.
        if (active) { setDetail({ ...data, pool: withAssetOverrides(data.pool), interval: chartInterval }); setState("ready"); }
      } catch (error) {
        if (active) setState(error instanceof Error && error.message === "missing" ? "missing" : "unavailable");
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    // The indexer polls the chain every few seconds, so read again shortly after a confirmed action.
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qwakk:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qwakk:tx-confirmed", reloadSoon); };
  }, [poolId, chartInterval]);

  if (state !== "ready" || !detail) {
    const message = state === "loading" ? "Reading current pool data…" : state === "missing" ? copy("This pool does not exist on QoreChain Diana.") : "Pool data is temporarily unavailable. This page retries on its own.";
    return <div className="app-shell"><QwakkHeader page="pools" /><main className="app-main"><div className="container"><Link className="back-link" href="/pools"><ArrowLeft size={15} />All pools</Link><div className="panel empty"><p>{message}</p></div></div></main><SiteFooter /></div>;
  }

  const { pool, swaps } = detail;
  const candles = detail.quote_candles ?? [];
  // A switched interval keeps the last chart on screen, dimmed, until its own candles land.
  const chartLoading = detail.interval !== chartInterval;
  const { base, quote } = marketSides(pool);
  const reserves = marketReserves(pool, 6);
  const volume = marketVolume(pool);
  // Same rule as the quote and transaction routes: anything but "active" is paused.
  const paused = pool.status !== "active";
  // A low-liquidity pool's price is not meaningful, so it is never the headline.
  const lowLiquidity = isLowLiquidity(pool);
  const tooThinToTrade = lowLiquidity && (pool.low_liquidity_reason === "dust_reserve" || pool.low_liquidity_reason === "empty");
  const latest = lowLiquidity ? null : marketPrice(pool);
  return <div className="app-shell">
    <QwakkHeader page="pools" />
    <main className="app-main">
      {/* pool-page: on phones the swap action docks above the tab bar instead of sitting below the chart and swaps. */}
      <div className="container pool-page">
        <Link className="back-link" href="/pools"><ArrowLeft size={15} />All pools</Link>
        <section className="pool-head">
          <div className="cell-main">
            <span className="coin-avatar is-large"><TokenIcon denom={base.denom} size="avatar" /><span className="coin-badge"><TokenIcon denom={quote.denom} size="small" /></span></span>
            <div><span className="kicker">Pool #{pool.id}</span><h1>{pairLabel(pool, " / ")}</h1></div>
          </div>
          {lowLiquidity
            ? <div className="pool-head-price"><span className="stat-label">Latest price</span><strong className="is-muted">Not shown</strong><span className="subtle">Too little liquidity</span></div>
            : <div className="pool-head-price"><span className="stat-label">Latest price</span><strong>{latest === null ? "No swaps yet" : `${formatQuotePrice(latest)} ${quote.symbol}`}</strong><span className="subtle">{priceUnit(pool)}</span></div>}
        </section>

        {lowLiquidity && <div className="pool-warning" role="note">
          <AlertTriangle size={16} aria-hidden="true" />
          <div><b>{tooThinToTrade ? "This pool is too thin to trade" : "Low-liquidity pool"}</b><p>{lowLiquidityCopy(pool.low_liquidity_reason)} Its price is left out of the pool lists until it holds real liquidity.</p></div>
        </div>}

        <section className="stat-row" aria-label="Pool summary">
          <div className="stat-card stat"><span className="stat-label">{base.symbol} reserve</span><span className="stat-value num">{reserves.base}</span></div>
          <div className="stat-card stat"><span className="stat-label">{quote.symbol} reserve</span><span className="stat-value num">{reserves.quote}</span></div>
          <div className="stat-card stat"><span className="stat-label">24h volume</span><span className="stat-value num">{volume.value === null ? "None yet" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(volume.value)} ${volume.symbol}`}</span></div>
        </section>

        <div className="pool-layout">
          <div className="pool-main">
            <section className="panel" aria-labelledby="pool-chart-title">
              <div className="panel-head chart-head">
                <div><span className="panel-title" id="pool-chart-title">{base.symbol} price in {quote.symbol}</span><span className="cell-sub">{CHART_INTERVAL_LABELS[chartInterval]}</span></div>
                {!lowLiquidity && <ChartIntervalTabs value={chartInterval} onChange={setChartInterval} />}
              </div>
              {/* Same rule as the swap page: a low-liquidity pool's price is not meaningful, so it is not charted. */}
              {lowLiquidity
                ? <ChartMessage>No chart for this pool: it holds too little to give a meaningful price.</ChartMessage>
                : candles.length > 0
                  ? <PoolChart candles={candles} interval={detail.interval} unit={priceUnit(pool)} quoteSymbol={quote.symbol} resetKey={`${pool.id}|${detail.interval}`} loading={chartLoading} />
                  : <ChartMessage loading={chartLoading}>{chartLoading ? "Loading the pool chart…" : chartEmptyCopy(chartInterval)}</ChartMessage>}
            </section>
            <RecentSwaps pool={pool} swaps={swaps} />
          </div>
          <aside className="panel" aria-labelledby="pool-info-title">
            <div className="pool-trade">{paused
              ? <p className="pool-paused" role="status"><PauseCircle size={16} aria-hidden="true" /><span>{copy(QUOTE_BLOCK_COPY.paused)}</span></p>
              : tooThinToTrade
                ? <p className="pool-paused" role="status"><AlertTriangle size={16} aria-hidden="true" /><span>Swaps are not offered here: this pool holds too little to trade at a fair price.</span></p>
              : <Link className="btn btn-primary btn-block" href={`/swap?pool=${pool.id}`}>{nativeActions ? `Swap ${base.symbol} and ${quote.symbol}` : "Get a live quote"}</Link>}</div>
            <div className="panel-head"><span className="panel-title" id="pool-info-title">Pool details</span></div>
            <div className="info-list">
              <div><span>Status</span><b>{pool.status}</b></div>
              <div><span>Type</span><b>{pool.pool_type.replace(/_/g, " ")}</b></div>
              <div><span>LP supply</span><b className="num">{pool.lp_supply ? formatBaseAmount(pool.lp_supply, LP_TOKEN_DECIMALS, 4) : "Not available"}</b></div>
              <div><span>Created at block</span><b className="num">{pool.created_height ? new Intl.NumberFormat("en-US").format(Number(pool.created_height)) : "Not available"}</b></div>
              <div><span>Creator</span><b className="mono">{shortAddress(pool.creator ?? null)}</b></div>
            </div>
            <p className="panel-note">Liquidity is held by the pool on QoreChain. {BRAND.name} never holds assets.</p>
            {liquidityActions && <>
              <div className="panel-head panel-head-split"><span className="panel-title">{actions.add_liquidity ? "Liquidity" : "Withdraw liquidity"}</span></div>
              {walletAddress
                ? <LiquidityPanel pool={pool} walletAddress={walletAddress} allowAdd={actions.add_liquidity} allowRemove={actions.remove_liquidity} />
                : <div className="panel-body"><button type="button" className="btn btn-primary btn-block" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button></div>}
            </>}
          </aside>
        </div>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
