"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowDownUp, Layers } from "lucide-react";
import { PriceChart } from "../../components/PriceChart";
import { QwakkHeader } from "../../components/QwakkHeader";
import { SiteFooter } from "../../components/SiteFooter";
import { TokenIcon } from "../../components/TokenIcon";
import { TxProgress } from "../../components/TxProgress";
import { useFeatures } from "../../components/useFeatures";
import { useNativeTransaction } from "../../components/useNativeTransaction";
import { useQorMarket } from "../../components/useQorMarket";
import { useWalletBalances } from "../../components/useWalletBalances";
import { assetForDenom, displaySymbol, formatBaseAmount, toBaseAmount } from "../../lib/qwakk-assets";
import { DEFAULT_SLIPPAGE_BPS, IMPACT_WARN_BPS, SLIPPAGE_PRESETS_BPS, SLIPPAGE_WARN_BPS, coversSpend, parseSlippagePercent, quoteKey, requoteDecision, type SwapQuote } from "../../lib/qwakk-quote";
import { QUOTE_BLOCK_COPY, QUOTE_FAILURE_COPY } from "../../lib/qwakk-tx-copy";
import { MARKET_RANGES, MARKET_RANGE_LABELS, formatChange, formatUsdCompact, formatUsdPrice, type MarketRange } from "../../lib/qor-price";

type RawPool = {
  id?: string | number;
  pool_id?: string | number;
  token_a?: string | { denom?: string };
  token_b?: string | { denom?: string };
  pool_type?: string;
  type?: string;
  status?: string;
};

type Quote = SwapQuote;
type QuoteEntry = { key: string; data: Quote };

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
  const kind = (pool.pool_type ?? pool.type ?? "liquidity_pool").replace(/_/g, " ");
  return pool.status === "paused" ? `${kind}, paused` : kind;
}

function percent(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Asks the server for a quote. A thrown error carries only controlled copy:
 * the route's own `error` field, or a fixed line when the network, a proxy or
 * a non-JSON body gets in the way. Browser and parser text never surfaces.
 */
async function requestQuote(params: { poolId: string; denomIn: string; amountIn: string; slippageBps: number }, signal?: AbortSignal): Promise<Quote> {
  const query = new URLSearchParams({ poolId: params.poolId, denomIn: params.denomIn, amountIn: params.amountIn, slippageBps: String(params.slippageBps) });
  let response: Response;
  try {
    response = await fetch(`/api/swap-quote?${query}`, { cache: "no-store", signal });
  } catch {
    throw new Error(QUOTE_FAILURE_COPY.unavailable);
  }
  let data: Quote & { error?: unknown };
  try {
    data = await response.json() as Quote & { error?: unknown };
  } catch {
    throw new Error(QUOTE_FAILURE_COPY.unavailable);
  }
  if (!response.ok) throw new Error(typeof data?.error === "string" && data.error ? data.error : QUOTE_FAILURE_COPY.unavailable);
  if (!data || typeof data.minOut !== "string" || typeof data.amountOut !== "string") throw new Error(QUOTE_FAILURE_COPY.unavailable);
  return data;
}

/** The amount in base units, or the controlled reason it cannot be used. */
function checkAmount(amount: string, decimals: number) {
  try {
    return { base: toBaseAmount(amount, decimals), error: "" };
  } catch (error) {
    return { base: "", error: error instanceof Error ? error.message : "Enter a valid amount" };
  }
}

/** Quotes refresh on their own while they are on screen. */
const QUOTE_REFRESH_MS = 15_000;

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
  const [slippageChoice, setSlippageChoice] = useState<string>(String(DEFAULT_SLIPPAGE_BPS));
  const [customSlippage, setCustomSlippage] = useState("");
  const [quoteEntry, setQuoteEntry] = useState<QuoteEntry | null>(null);
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
  // The quote the trader reviewed, frozen when Review is clicked. Auto-refresh
  // never changes it; confirm compares the fresh quote against it.
  const [reviewed, setReviewed] = useState<QuoteEntry | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reviewNotice, setReviewNotice] = useState("");
  const [quoteVersion, setQuoteVersion] = useState(0);
  const balances = useWalletBalances(walletAddress);

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
  const selectedId = poolId(selectedPool);
  // Price protection: a preset, or a custom percent from 0.01% to 5%.
  const slippageBps = slippageChoice === "custom" ? parseSlippagePercent(customSlippage) : Number(slippageChoice);
  const amountCheck = checkAmount(amount, inputDecimals);
  const amountBase = amountCheck.base;
  const amountError = amountCheck.error;
  const currentKey = selectedPool && denomIn && amountCheck.base && slippageBps !== null
    ? quoteKey({ poolId: selectedId, denomIn, amountIn: amountCheck.base, slippageBps })
    : "";
  // A quote is used only for the exact inputs it was made for, so a switched
  // direction, pool, amount or protection never signs against an old minimum.
  const quote = quoteEntry && quoteEntry.key === currentKey ? quoteEntry.data : null;
  const reviewedQuote = reviewed && reviewed.key === currentKey ? reviewed.data : null;
  const reviewing = Boolean(reviewedQuote);

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
        setQuoteState("idle");
        setQuoteError("");
        return;
      }
      if (!amountBase) {
        setQuoteState("unavailable");
        setQuoteError(amountError);
        return;
      }
      if (slippageBps === null) {
        setQuoteState("unavailable");
        setQuoteError("Set price protection between 0.01% and 5%.");
        return;
      }

      setQuoteState("loading");
      setQuoteError("");
      const key = quoteKey({ poolId: selectedId, denomIn, amountIn: amountBase, slippageBps });
      try {
        const data = await requestQuote({ poolId: selectedId, denomIn, amountIn: amountBase, slippageBps }, controller.signal);
        setQuoteEntry({ key, data });
        setQuoteState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setQuoteEntry(null);
        setQuoteState("unavailable");
        setQuoteError(error instanceof Error ? error.message : QUOTE_FAILURE_COPY.unavailable);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [amountBase, amountError, denomIn, denomOut, selectedId, selectedPool, slippageBps, quoteVersion]);

  // Keep the quote current while it is on screen, but not while the trader
  // reviews it or a transaction is running: the reviewed numbers stay put.
  const hasQuote = Boolean(quote);
  useEffect(() => {
    if (!hasQuote || reviewing || tx.busy || confirming) return;
    const timer = window.setInterval(() => setQuoteVersion((value) => value + 1), QUOTE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasQuote, reviewing, tx.busy, confirming]);

  function selectPool(pool: RawPool) {
    setSelectedPoolId(poolId(pool));
    setReversed(false);
    setReviewed(null);
    setReviewNotice("");
  }

  function editInputs(update: () => void) {
    update();
    setReviewed(null);
    setReviewNotice("");
  }

  /**
   * Re-quotes at sign time. The swap is signed only if the fresh quote still
   * guarantees at least the minimum the trader reviewed; otherwise the new
   * numbers go back on screen for another review.
   */
  async function confirmSwap() {
    if (!reviewed || !reviewedQuote || !selectedPool || confirming || tx.busy || slippageBps === null || !amountCheck.base) return;
    const params = { poolId: selectedId, denomIn, amountIn: amountCheck.base, slippageBps };
    // The inputs must still be exactly the ones the trader reviewed.
    if (quoteKey(params) !== reviewed.key) {
      setReviewed(null);
      return;
    }
    setConfirming(true);
    setReviewNotice("");
    let fresh: Quote;
    try {
      fresh = await requestQuote(params);
    } catch (error) {
      setConfirming(false);
      setReviewNotice(error instanceof Error ? error.message : QUOTE_FAILURE_COPY.unavailable);
      return;
    }
    setQuoteEntry({ key: quoteKey(params), data: fresh });
    if (requoteDecision(reviewedQuote.minOut, fresh) === "review") {
      setConfirming(false);
      // Show the new numbers as the ones under review, so the next confirm
      // compares against what is now on screen.
      setReviewed(fresh.blocked ? null : { key: reviewed.key, data: fresh });
      setReviewNotice(fresh.blocked ? QUOTE_BLOCK_COPY[fresh.blocked] : "The price moved since you reviewed it. Check the new minimum, then confirm again.");
      return;
    }
    setConfirming(false);
    void tx.run({ kind: "swap", poolId: selectedId, denomIn, amountIn: amountCheck.base, denomOut, minOut: fresh.minOut });
  }

  const output = quote ? formatBaseAmount(quote.amountOut, outputDecimals, 6) : quoteState === "loading" ? "…" : "0.0";
  const outputHint = quoteState === "unavailable" ? quoteError : !selectedPool ? "A quote appears once QoreChain Diana has a pool." : quote?.source === "estimate" ? "Estimated from pool reserves. The QoreChain Diana quote service did not answer." : outputDecimals === 0 && denomOut ? `${denomOut} base units` : `Quoted by QoreChain Diana in ${shortDenom(denomOut)}`;
  const enoughBalance = balances && amountCheck.base ? coversSpend({ balances, spend: [{ denom: denomIn, amount: amountCheck.base }] }) : null;
  const impactHigh = quote?.priceImpactBps !== null && quote?.priceImpactBps !== undefined && quote.priceImpactBps >= IMPACT_WARN_BPS;
  const blockCopy = quote?.blocked ? QUOTE_BLOCK_COPY[quote.blocked] : "";
  const maxHint = quote?.blocked === "impact" && quote.maxAmountIn && quote.maxAmountIn !== "0" ? quote.maxAmountIn : "";
  const canReview = Boolean(quote && !quote.blocked && enoughBalance !== false);
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
              <span className="quote-field-top"><span>You pay</span><span className="quick-amounts" role="group" aria-label="Quick amounts">{QUICK_AMOUNTS.map((value) => <button type="button" key={value} aria-pressed={amount === value} disabled={tx.busy || confirming} onClick={() => editInputs(() => setAmount(value))}>{new Intl.NumberFormat("en-US").format(Number(value))}</button>)}</span></span>
              <span className="quote-field-row"><input aria-label={`Amount in ${shortDenom(denomIn || "uqor")}`} inputMode="decimal" value={amount} disabled={tx.busy || confirming} onChange={(event) => { const next = event.target.value; editInputs(() => setAmount(next)); }} /><span className="token-chip"><TokenIcon denom={denomIn || "uqor"} size="small" />{shortDenom(denomIn || "uqor")}</span></span>
              <span className="quote-hint">{inputHint}</span>
              {walletAddress && enoughBalance === false && <span className="quote-hint is-error">{denomIn === "uqor" ? "Not enough QOR for this amount plus the network fee." : `Not enough ${shortDenom(denomIn)} for this amount, or not enough QOR for the network fee.`}</span>}
            </div>
            <button type="button" className="quote-switch" aria-label="Switch tokens" disabled={!selectedPool || tx.busy || confirming} onClick={() => editInputs(() => setReversed((current) => !current))}><ArrowDownUp size={16} /></button>
            <div className="quote-field">
              <span className="quote-field-top"><span>You receive</span></span>
              <span className="quote-field-row"><output aria-live="polite">{output}</output>{denomOut ? <span className="token-chip"><TokenIcon denom={denomOut} size="small" />{shortDenom(denomOut)}</span> : <span className="token-chip subtle">Select a pool</span>}</span>
              <span className={`quote-hint ${quoteState === "unavailable" ? "is-error" : ""}`}>{outputHint}</span>
            </div>
            {/* One notice slot under the amounts: a blocked quote (with the largest amount the pool takes) or a high price impact. */}
            {(blockCopy || (impactHigh && !quote?.blocked)) && <div className="quote-alert">
              <p className="quote-alert-text"><AlertTriangle size={14} aria-hidden="true" /><span>{blockCopy
                ? <>{blockCopy}{maxHint && <> The most this pool takes in one swap is about {formatBaseAmount(maxHint, inputDecimals, 6)} {shortDenom(denomIn)}.</>}</>
                : <>This swap moves the pool price by {percent(quote?.priceImpactBps ?? 0)}. You get noticeably less than the current price.</>}</span></p>
              {maxHint && <button type="button" className="btn btn-ghost btn-sm" disabled={tx.busy || confirming} onClick={() => editInputs(() => setAmount(formatBaseAmount(maxHint, inputDecimals, inputDecimals)))}>Use {formatBaseAmount(maxHint, inputDecimals, 6)} {shortDenom(denomIn)}</button>}
            </div>}
            <div className="quote-meta">
              <div className="quote-meta-row"><span>Price impact</span><b className={`num ${impactHigh ? "down" : ""}`}>{quote ? quote.priceImpactBps === null ? "Checked by QoreChain Diana" : quote.priceImpactBps === 0 ? "Under 0.01%" : percent(quote.priceImpactBps) : "Not available"}</b></div>
              <div className="quote-meta-row"><span>Minimum received</span><b className="num">{quote && !quote.blocked ? `${formatBaseAmount(quote.minOut, outputDecimals, 6)} ${shortDenom(denomOut)}` : "Not available"}</b></div>
              <div className="quote-meta-row"><span>Pool fee</span><b className="num">{quote ? `${formatBaseAmount(quote.nativeAmmFee, inputDecimals, 6)} ${shortDenom(denomIn)}` : "Not available"}</b></div>
              <div className="quote-meta-row"><Link className="fee-link" href="/fees">Interface fee</Link><b>{feeLabel}</b></div>
              <div className="quote-meta-row"><label htmlFor="slippage">Price protection</label><select id="slippage" value={slippageChoice} disabled={tx.busy || confirming} onChange={(event) => { const next = event.target.value; editInputs(() => setSlippageChoice(next)); }}>{SLIPPAGE_PRESETS_BPS.map((value) => <option key={value} value={String(value)}>{percent(value)}</option>)}<option value="custom">Custom</option></select></div>
              {slippageChoice === "custom" && <div className="quote-meta-row"><label htmlFor="slippage-custom">Custom protection (%)</label><input id="slippage-custom" className="quote-meta-input" inputMode="decimal" placeholder="0.50" value={customSlippage} disabled={tx.busy || confirming} onChange={(event) => { const next = event.target.value; editInputs(() => setCustomSlippage(next)); }} /></div>}
              {slippageBps === null && <p className="quote-hint is-error">Set price protection between 0.01% and 5%.</p>}
              {slippageBps !== null && slippageBps > SLIPPAGE_WARN_BPS && <p className="quote-hint is-error">Protection above 1% lets the swap settle at a noticeably worse price.</p>}
            </div>
            {nativeActions && <div className="swap-action">
              {tx.state.phase !== "idle"
                ? <TxProgress state={tx.state} onDone={() => { tx.reset(); setReviewed(null); setReviewNotice(""); }} />
                : reviewedQuote
                  ? <div className="review">
                    <p className="review-line">You pay <b>{formatBaseAmount(reviewedQuote.totalAmountIn, inputDecimals, 6)} {shortDenom(denomIn)}</b> and receive at least <b>{formatBaseAmount(reviewedQuote.minOut, outputDecimals, 6)} {shortDenom(denomOut)}</b>.{reviewedQuote.interfaceFee.enabled && reviewedQuote.interfaceFee.amount !== "0" && <> This includes a <b>{formatBaseAmount(reviewedQuote.interfaceFee.amount, inputDecimals, 6)} {shortDenom(denomIn)}</b> interface fee.</>}</p>
                    {reviewNotice && <p className="quote-hint is-error" role="alert">{reviewNotice}</p>}
                    <div className="review-actions">
                      <button type="button" className="btn btn-ghost" disabled={confirming} onClick={() => { setReviewed(null); setReviewNotice(""); }}>Edit</button>
                      <button type="button" className="btn btn-primary" disabled={confirming || !canReview} onClick={() => void confirmSwap()}>{confirming ? "Checking the price…" : "Confirm in QoreX"}</button>
                    </div>
                  </div>
                  : !walletAddress
                    ? <button type="button" className="btn btn-primary btn-block" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>
                    : <>
                      {reviewNotice && <p className="quote-hint is-error" role="alert">{reviewNotice}</p>}
                      <button type="button" className="btn btn-primary btn-block" disabled={!canReview} onClick={() => { if (quote && currentKey) setReviewed({ key: currentKey, data: quote }); setReviewNotice(""); }}>{quote?.blocked === "impact" ? "Too large for this pool" : quote?.blocked === "paused" ? "Pool paused" : quote?.blocked ? "Swap unavailable" : enoughBalance === false ? `Not enough ${shortDenom(denomIn)}` : quote ? "Review swap" : !selectedPool ? "No pool selected" : quoteState === "loading" ? "Getting a quote…" : "Quote unavailable"}</button>
                    </>}
            </div>}
            <p className="quote-status"><span className={`dot ${networkState === "ready" && pools.length ? "live" : ""}`} />{readiness}</p>
          </div>
        </aside>
      </div>
    </main>
    <SiteFooter />
  </div>;
}
