"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownUp, Layers } from "lucide-react";
import { PriceChart } from "../../components/PriceChart";
import { QwakkHeader } from "../../components/QwakkHeader";
import { SiteFooter } from "../../components/SiteFooter";
import { TokenIcon } from "../../components/TokenIcon";
import { TxProgress } from "../../components/TxProgress";
import { useFeatures } from "../../components/useFeatures";
import { useNativeTransaction } from "../../components/useNativeTransaction";
import { useQorMarket } from "../../components/useQorMarket";
import { assetForDenom, displaySymbol, formatBaseAmount, toBaseAmount } from "../../lib/qwakk-assets";
import { MARKET_RANGES, MARKET_RANGE_LABELS, formatChange, formatUsdCompact, formatUsdPrice, type MarketRange } from "../../lib/qor-price";

type RawPool = {
  id?: string | number;
  pool_id?: string | number;
  token_a?: string | { denom?: string };
  token_b?: string | { denom?: string };
  pool_type?: string;
  type?: string;
};

type Quote = {
  amountOut: string;
  minOut: string;
  nativeAmmFee: string;
  slippageBps: number;
  interfaceFee: { enabled: boolean; amount: string; denom: string; feeBps: number };
};

type FeeConfig = { enabled: boolean; feeBps: number };
type NetworkState = "checking" | "ready" | "unavailable";
type QuoteState = "idle" | "loading" | "ready" | "unavailable";

function poolId(pool?: RawPool) {
  return String(pool?.id ?? pool?.pool_id ?? "");
}

function poolDenom(pool: RawPool | undefined, side: "a" | "b") {
  const value = side === "a" ? pool?.token_a : pool?.token_b;
  return typeof value === "string" ? value : value?.denom ?? "";
}

function poolKind(pool: RawPool) {
  return (pool.pool_type ?? pool.type ?? "liquidity_pool").replace(/_/g, " ");
}

/** Quick amounts for the pay field, in display units of the input token. */
const QUICK_AMOUNTS = ["1", "10", "100", "1000"];

function shortDenom(denom: string) {
  return denom ? displaySymbol(denom) : "Unknown";
}

export default function SwapPage() {
  const [pools, setPools] = useState<RawPool[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const [reversed, setReversed] = useState(false);
  const [amount, setAmount] = useState("1");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quoteError, setQuoteError] = useState("");
  // Null until /api/qwakk-fee answers; "unknown" when it could not be read.
  const [feeConfig, setFeeConfig] = useState<FeeConfig | "unknown" | null>(null);
  const [networkState, setNetworkState] = useState<NetworkState>("checking");
  const [lastUpdated, setLastUpdated] = useState("Checking QoreChain Diana markets");
  const [range, setRange] = useState<MarketRange>("7");
  const market = useQorMarket(range);
  const { nativeActions } = useFeatures();
  const tx = useNativeTransaction();
  const [walletAddress, setWalletAddress] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [quoteVersion, setQuoteVersion] = useState(0);

  const selectedPool = useMemo(
    () => pools.find((pool) => poolId(pool) === selectedPoolId) ?? pools[0],
    [pools, selectedPoolId],
  );
  const denomA = poolDenom(selectedPool, "a");
  const denomB = poolDenom(selectedPool, "b");
  const denomIn = reversed ? denomB : denomA;
  const denomOut = reversed ? denomA : denomB;
  const inputDecimals = assetForDenom(denomIn)?.decimals ?? 0;
  const outputDecimals = assetForDenom(denomOut)?.decimals ?? 0;

  const refreshPools = useCallback(async () => {
    try {
      const response = await fetch("/api/network", { cache: "no-store" });
      if (!response.ok) throw new Error("Network unavailable");
      const data = await response.json() as { pools?: RawPool[] };
      const nextPools = Array.isArray(data.pools) ? data.pools : [];
      setPools(nextPools);
      // Pool pages link here with ?pool=<id> to open that pool first.
      const requested = new URLSearchParams(window.location.search).get("pool") ?? "";
      setSelectedPoolId((current) => nextPools.some((pool) => poolId(pool) === current) ? current : nextPools.some((pool) => poolId(pool) === requested) ? requested : poolId(nextPools[0]));
      setNetworkState("ready");
      setLastUpdated(`QoreChain Diana checked ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
      setNetworkState("unavailable");
      setLastUpdated("QoreChain Diana markets are temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPools(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshPools]);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qwakk-wallet-address") ?? "");
    const refreshAfterTx = () => { void refreshPools(); setQuoteVersion((value) => value + 1); };
    restoreWallet();
    window.addEventListener("qwakk:wallet-change", restoreWallet);
    window.addEventListener("qwakk:tx-confirmed", refreshAfterTx);
    return () => {
      window.removeEventListener("qwakk:wallet-change", restoreWallet);
      window.removeEventListener("qwakk:tx-confirmed", refreshAfterTx);
    };
  }, [refreshPools]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/qwakk-fee", { cache: "no-store" });
        if (!response.ok) throw new Error("Fee disclosure unavailable");
        const data = await response.json() as FeeConfig;
        setFeeConfig({ enabled: Boolean(data.enabled), feeBps: Number(data.feeBps) || 0 });
      } catch {
        // Never show "None" for a fee that could not be read. The quote carries
        // the authoritative fee once it loads.
        setFeeConfig("unknown");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      if (!selectedPool || !denomIn || !denomOut) {
        setQuote(null);
        setQuoteState("idle");
        setQuoteError("");
        return;
      }

      let amountIn: string;
      try {
        amountIn = toBaseAmount(amount, inputDecimals);
      } catch (error) {
        setQuote(null);
        setQuoteState("unavailable");
        setQuoteError(error instanceof Error ? error.message : "Enter a valid amount");
        return;
      }

      setQuoteState("loading");
      setQuoteError("");
      try {
        const query = new URLSearchParams({
          poolId: poolId(selectedPool),
          denomIn,
          amountIn,
          slippageBps: String(slippageBps),
        });
        const response = await fetch(`/api/swap-quote?${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as Quote & { error?: string };
        if (!response.ok) throw new Error(data.error || "Quote is temporarily unavailable");
        setQuote(data);
        setQuoteState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuote(null);
        setQuoteState("unavailable");
        setQuoteError(error instanceof Error ? error.message : "Quote is temporarily unavailable");
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [amount, denomIn, denomOut, inputDecimals, selectedPool, slippageBps, quoteVersion]);

  function selectPool(pool: RawPool) {
    setSelectedPoolId(poolId(pool));
    setReversed(false);
    setReviewing(false);
  }

  function confirmSwap() {
    if (!quote || !selectedPool) return;
    let amountIn: string;
    try {
      amountIn = toBaseAmount(amount, inputDecimals);
    } catch {
      return;
    }
    void tx.run({ kind: "swap", poolId: poolId(selectedPool), denomIn, amountIn, denomOut, minOut: quote.minOut });
  }

  const output = quote ? formatBaseAmount(quote.amountOut, outputDecimals, 6) : quoteState === "loading" ? "…" : "0.0";
  const outputHint = quoteState === "unavailable" ? quoteError : !selectedPool ? "A quote appears once QoreChain Diana has a pool." : outputDecimals === 0 && denomOut ? `${denomOut} base units` : `Estimated ${shortDenom(denomOut)}`;
  const inputHint = inputDecimals === 0 && denomIn ? `Enter ${denomIn} base units.` : `Enter ${shortDenom(denomIn || "uqor")}. Converted to the on-chain unit for you.`;
  // The quote comes from the same server fee configuration that prepares the transaction.
  const feeSource = quote?.interfaceFee ?? (feeConfig && feeConfig !== "unknown" ? feeConfig : null);
  const feeLabel = feeSource ? (feeSource.enabled && feeSource.feeBps > 0 ? `${(feeSource.feeBps / 100).toFixed(2)}%` : "None") : feeConfig === "unknown" ? "Shown with the quote" : "Checking…";
  const readiness = networkState === "checking" ? "Checking QoreChain Diana" : networkState === "unavailable" ? "QoreChain Diana is unavailable" : pools.length ? "Live quotes from the native AMM" : "No QoreChain Diana pool is open yet";
  const change = market.data?.change24h ?? null;

  return <div className="app-shell">
    <QwakkHeader page="swap" />
    <main className="app-main">
      <div className="container trade-grid">
        <div className="trade-main">
          <section className="panel pair-bar" aria-label="QOR market">
            <div className="pair-title"><TokenIcon denom="uqor" size="large" /><div><b>QOR <span className="subtle">/ USD</span></b><span className="cell-sub">QoreChain native coin</span></div></div>
            <div className="pair-quote"><div className="pair-price num">{market.data ? formatUsdPrice(market.data.price) : market.status === "unavailable" ? "Not available" : "…"}</div>{market.data && <span className={`change-pill ${change !== null && change < 0 ? "is-down" : "is-up"}`}>{formatChange(change)} 24h</span>}</div>
            <div className="pair-stats">
              <div className="stat"><span className="stat-label">24h volume</span><span className="stat-value">{formatUsdCompact(market.data?.volume24h ?? null)}</span></div>
              <div className="stat"><span className="stat-label">Market cap</span><span className="stat-value">{formatUsdCompact(market.data?.marketCap ?? null)}</span></div>
            </div>
          </section>

          <section className="panel" aria-labelledby="chart-title">
            <div className="panel-head">
              <span className="panel-title" id="chart-title">QOR price in USD</span>
              <div className="segmented" role="group" aria-label="Chart range">{MARKET_RANGES.map((option) => <button type="button" key={option} aria-pressed={option === range} onClick={() => setRange(option)}>{MARKET_RANGE_LABELS[option]}</button>)}</div>
            </div>
            {market.data && market.data.points.length > 1
              ? <PriceChart points={market.data.points} dimmed={market.status === "refreshing"} />
              : <div className="chart-empty" style={{ height: 360 }}>{market.status === "unavailable" ? "QOR market data is temporarily unavailable." : "Loading QOR market data…"}</div>}
            <p className="panel-note">QOR market across exchanges, from <a href="https://www.coingecko.com/en/coins/qorechain" target="_blank" rel="noreferrer">CoinGecko</a>. Pool prices on QoreChain Diana can differ.</p>
          </section>

          <section className="panel" aria-labelledby="pools-title">
            <div className="panel-head"><span className="panel-title" id="pools-title">QoreChain Diana pools</span><span className="subtle"><span className={`dot ${networkState === "ready" ? "live" : ""}`} /> {lastUpdated}</span></div>
            {pools.length ? <div className="table">{pools.map((pool, index) => {
              const id = poolId(pool) || String(index + 1);
              const tokenA = poolDenom(pool, "a");
              const tokenB = poolDenom(pool, "b");
              const selected = id === poolId(selectedPool);
              return <button type="button" className={`table-row pool-pick ${selected ? "is-selected" : ""}`} key={id} onClick={() => selectPool(pool)} aria-pressed={selected}>
                <span className="cell-main"><span className="pair-icons"><TokenIcon denom={tokenA} size="regular" /><TokenIcon denom={tokenB} size="regular" /></span><span><b>{shortDenom(tokenA)} / {shortDenom(tokenB)}</b><small>{poolKind(pool)}</small></span></span>
                <span className="subtle mono">#{id}</span>
              </button>;
            })}</div> : <div className="empty">
              <span className="empty-icon"><Layers size={18} /></span>
              <h3>No pools are open yet</h3>
              <p>QoreChain Diana has no native AMM pool right now. This list and the quote card update on their own when the first one opens.</p>
              <Link className="btn btn-ghost btn-sm" href="/pools">View all markets</Link>
            </div>}
          </section>
        </div>

        <aside className="panel quote-card" aria-labelledby="quote-title">
          <div className="panel-head"><span className="panel-title" id="quote-title">{nativeActions ? "Swap" : "Quote"}</span><span className="kicker">Native AMM</span></div>
          <div className="panel-body">
            <div className="quote-field">
              <span className="quote-field-top"><span>You pay</span><span className="quick-amounts" role="group" aria-label="Quick amounts">{QUICK_AMOUNTS.map((value) => <button type="button" key={value} aria-pressed={amount === value} disabled={tx.busy} onClick={() => { setAmount(value); setReviewing(false); }}>{new Intl.NumberFormat("en-US").format(Number(value))}</button>)}</span></span>
              <span className="quote-field-row"><input aria-label={`Amount in ${shortDenom(denomIn || "uqor")}`} inputMode="decimal" value={amount} disabled={tx.busy} onChange={(event) => { setAmount(event.target.value); setReviewing(false); }} /><span className="token-chip"><TokenIcon denom={denomIn || "uqor"} size="small" />{shortDenom(denomIn || "uqor")}</span></span>
              <span className="quote-hint">{inputHint}</span>
            </div>
            <button type="button" className="quote-switch" aria-label="Switch tokens" disabled={!selectedPool} onClick={() => setReversed((current) => !current)}><ArrowDownUp size={16} /></button>
            <div className="quote-field">
              <span className="quote-field-top"><span>You receive</span></span>
              <span className="quote-field-row"><output aria-live="polite">{output}</output>{denomOut ? <span className="token-chip"><TokenIcon denom={denomOut} size="small" />{shortDenom(denomOut)}</span> : <span className="token-chip subtle">Select a pool</span>}</span>
              <span className={`quote-hint ${quoteState === "unavailable" ? "is-error" : ""}`}>{outputHint}</span>
            </div>
            <div className="quote-meta">
              <div className="quote-meta-row"><span>Minimum received</span><b className="num">{quote ? `${formatBaseAmount(quote.minOut, outputDecimals, 6)} ${shortDenom(denomOut)}` : "Not available"}</b></div>
              <div className="quote-meta-row"><span>Pool fee</span><b className="num">{quote ? `${formatBaseAmount(quote.nativeAmmFee, inputDecimals, 6)} ${shortDenom(denomIn)}` : "Not available"}</b></div>
              <div className="quote-meta-row"><Link className="fee-link" href="/fees">Interface fee</Link><b>{feeLabel}</b></div>
              <div className="quote-meta-row"><label htmlFor="slippage">Price protection</label><select id="slippage" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}><option value={10}>0.10%</option><option value={50}>0.50%</option><option value={100}>1.00%</option></select></div>
            </div>
            {nativeActions && <div className="swap-action">
              {tx.state.phase !== "idle"
                ? <TxProgress state={tx.state} onDone={() => { tx.reset(); setReviewing(false); }} />
                : reviewing && quote
                  ? <div className="review">
                    <p className="review-line">You pay <b>{amount} {shortDenom(denomIn)}</b> and receive at least <b>{formatBaseAmount(quote.minOut, outputDecimals, 6)} {shortDenom(denomOut)}</b>.{quote.interfaceFee.enabled && quote.interfaceFee.amount !== "0" && <> This includes a <b>{formatBaseAmount(quote.interfaceFee.amount, inputDecimals, 6)} {shortDenom(denomIn)}</b> interface fee.</>}</p>
                    <div className="review-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => setReviewing(false)}>Edit</button>
                      <button type="button" className="btn btn-primary" onClick={confirmSwap}>Confirm in QoreX</button>
                    </div>
                  </div>
                  : !walletAddress
                    ? <button type="button" className="btn btn-primary btn-block" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>
                    : <button type="button" className="btn btn-primary btn-block" disabled={!quote} onClick={() => setReviewing(true)}>{quote ? "Review swap" : !selectedPool ? "No pool selected" : quoteState === "loading" ? "Getting a quote…" : "Quote unavailable"}</button>}
            </div>}
            <p className="quote-status"><span className={`dot ${networkState === "ready" && pools.length ? "live" : ""}`} />{readiness}</p>
          </div>
        </aside>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
