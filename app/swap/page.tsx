"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowDownUp, Layers, Search } from "lucide-react";
import { FaucetHint } from "../../components/FaucetHint";
import { useNetworkCopy } from "../../components/NetworkContext";
import { ChartIntervalTabs } from "../../components/ChartIntervalTabs";
import { ChartMessage, PoolChart } from "../../components/PoolChart";
import { PriceChart } from "../../components/PriceChart";
import { QwakkHeader } from "../../components/QwakkHeader";
import { RecentSwaps } from "../../components/RecentSwaps";
import { SiteFooter } from "../../components/SiteFooter";
import { TokenIcon } from "../../components/TokenIcon";
import { TxProgress } from "../../components/TxProgress";
import { useFeatures } from "../../components/useFeatures";
import { useNativeTransaction } from "../../components/useNativeTransaction";
import { useQorMarket } from "../../components/useQorMarket";
import { useAssets } from "../../components/useAssets";
import { useMarkets } from "../../components/useMarkets";
import { usePoolDetail } from "../../components/usePoolDetail";
import { useWalletBalances } from "../../components/useWalletBalances";
import { formatBaseAmount, formatVisibleAmount, toBaseAmount } from "../../lib/qwakk-assets";
import { CHART_INTERVAL_LABELS, chartEmptyCopy, type ChartInterval } from "../../lib/qwakk-chart";
import { formatQuotePrice, isLowLiquidity, localLiquidityReason, lowLiquidityCopy, marketChange, marketPrice, marketSides, marketVolume, priceUnit, type QuoteMarket } from "../../lib/qwakk-market-view";
import { DEFAULT_SLIPPAGE_BPS, IMPACT_WARN_BPS, NETWORK_FEE_RESERVE_UQOR, SLIPPAGE_PRESETS_BPS, SLIPPAGE_WARN_BPS, coversSpend, parseSlippagePercent, quoteKey, requoteDecision, requoteExactOutDecision, type SwapQuote } from "../../lib/qwakk-quote";
import { QUOTE_BLOCK_COPY, QUOTE_FAILURE_COPY, QUOTE_ZERO_OUT_COPY, assetDecimalsUnknownCopy } from "../../lib/qwakk-tx-copy";
import { MARKET_RANGES, MARKET_RANGE_LABELS, formatChange, formatUsdPrice, type MarketRange } from "../../lib/qor-price";
import { BRAND } from "../../lib/brand";
import { SELECT_POOL_EVENT, searchEmptyCopy, searchPools, type SearchEntry } from "../../lib/qwakk-search";

type RawPool = {
  id?: string | number;
  pool_id?: string | number;
  token_a?: string | { denom?: string };
  token_b?: string | { denom?: string };
  pool_type?: string;
  type?: string;
  status?: string;
  /** Base units, as the chain reports them (`/api/network`). */
  reserve_a?: string;
  reserve_b?: string;
};

type Quote = SwapQuote;
type QuoteEntry = { key: string; data: Quote };

type FeeConfig = { enabled: boolean; feeBps: number };
/** Which amount the trader typed last. That side is fixed; the other one is quoted. */
type FixedSide = "in" | "out";
type QuoteParams = { poolId: string; denomIn: string; slippageBps: number } & ({ amountIn: string } | { amountOut: string });
type NetworkState = "checking" | "ready" | "unavailable";
type QuoteState = "idle" | "loading" | "ready" | "unavailable";

function poolId(pool?: RawPool) {
  return String(pool?.id ?? pool?.pool_id ?? "");
}

function poolDenom(pool: RawPool | undefined, side: "a" | "b") {
  const value = side === "a" ? pool?.token_a : pool?.token_b;
  return typeof value === "string" ? value : value?.denom ?? "";
}

const poolFigure = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const poolFigureCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** A pool total (volume, liquidity) in its quote token: compact from 100,000 up. */
function poolAmount(value: number | null, symbol: string) {
  if (value === null || !Number.isFinite(value)) return "Not available";
  return `${value >= 100_000 ? poolFigureCompact.format(value) : poolFigure.format(value)} ${symbol}`;
}

/** QoreChain quotes exact out (a fixed receive amount) only on constant-product pools. */
function supportsExactOut(pool?: RawPool) {
  return !pool || (pool.pool_type ?? pool.type ?? "constant_product") === "constant_product";
}

function poolKind(pool: RawPool) {
  const kind = (pool.pool_type ?? pool.type ?? "liquidity_pool").replace(/_/g, " ");
  return pool.status === "paused" ? `${kind}, paused` : kind;
}

/* Long figures step down a size so every digit stays visible. */
function amountSize(text: string) {
  return text.length > 12 ? "is-xlong" : text.length > 9 ? "is-long" : undefined;
}

function percent(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Asks the server for a quote. A thrown error carries only controlled copy:
 * the route's own `error` field, or a fixed line when the network, a proxy or
 * a non-JSON body gets in the way. Browser and parser text never surfaces.
 */
async function requestQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote> {
  const query = new URLSearchParams({ poolId: params.poolId, denomIn: params.denomIn, slippageBps: String(params.slippageBps) });
  if ("amountOut" in params) query.set("amountOut", params.amountOut);
  else query.set("amountIn", params.amountIn);
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

/**
 * The amount in base units, or the controlled reason it cannot be used. A
 * token whose decimals are unknown is never converted with a guess.
 */
function checkAmount(amount: string, decimals: number | null, symbol: string) {
  if (decimals === null) return { base: "", error: assetDecimalsUnknownCopy(symbol) };
  try {
    return { base: toBaseAmount(amount, decimals), error: "" };
  } catch (error) {
    return { base: "", error: error instanceof Error ? error.message : "Enter a valid amount" };
  }
}

/** Quotes refresh on their own while they are on screen. */
const QUOTE_REFRESH_MS = 15_000;

/**
 * Quick amounts for the pay field before a balance is known, in display units
 * and sized per token (one faucet claim is 100 QOR, 1,000 fUSD, 0.5 fETH and
 * 0.02 fBTC). Tokens not listed get no presets.
 */
const QUICK_AMOUNTS_BY_SYMBOL: Readonly<Record<string, readonly string[]>> = {
  QOR: ["1", "10", "100"],
  fUSD: ["10", "100", "1000"],
  fETH: ["0.01", "0.1", "0.5"],
  fBTC: ["0.001", "0.005", "0.02"],
  ATOM: ["1", "10", "100"],
};

/** Shares of the spendable balance offered once the wallet's balance is known. */
const BALANCE_SHARES = [{ label: "25%", percent: 25 }, { label: "50%", percent: 50 }, { label: "Max", percent: 100 }] as const;

export default function SwapPage() {
  const [pools, setPools] = useState<RawPool[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const [reversed, setReversed] = useState(false);
  // Half turns of the flip button's arrows. Purely visual: each tap adds one, so a
  // second tap mid-turn carries on from wherever the arrows are.
  const [flipTurns, setFlipTurns] = useState(0);
  const [amount, setAmount] = useState("1");
  // Typed in "You receive": the trader fixes what they get and the pay side is quoted (exact out).
  const [receiveAmount, setReceiveAmount] = useState("");
  const [fixedSide, setFixedSide] = useState<FixedSide>("in");
  const [slippageChoice, setSlippageChoice] = useState<string>(String(DEFAULT_SLIPPAGE_BPS));
  const [customSlippage, setCustomSlippage] = useState("");
  const [quoteEntry, setQuoteEntry] = useState<QuoteEntry | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quoteError, setQuoteError] = useState("");
  // Null until /api/qwakk-fee answers; "unknown" when it could not be read.
  const [feeConfig, setFeeConfig] = useState<FeeConfig | "unknown" | null>(null);
  const [networkState, setNetworkState] = useState<NetworkState>("checking");
  const { copy, label: networkLabel } = useNetworkCopy();
  // When the pool list was last read, as "14:05". Empty until the first read.
  const [checkedAt, setCheckedAt] = useState("");
  // Low-liquidity pools stay out of the picker unless asked for (or opened by link).
  const { markets } = useMarkets(30_000);
  const [showLowLiquidity, setShowLowLiquidity] = useState(false);
  // Filters the pool picker with the same matcher as the top bar search.
  const [poolQuery, setPoolQuery] = useState("");
  // The amount the trader set from the pool's one-swap limit ("in:1.5" or "out:1.5"), so the note can say so.
  const [clampedAmount, setClampedAmount] = useState("");
  const [range, setRange] = useState<MarketRange>("7");
  // The pair bar, chart and recent swaps follow the selected pool (indexer data, as on the pool page).
  // The CoinGecko QOR/USD chart stays one tap away as a secondary view, labeled with its source.
  const [chartView, setChartView] = useState<"pool" | "qor">("pool");
  const [chartInterval, setChartInterval] = useState<ChartInterval>("1h");
  const market = useQorMarket(range);
  // Each wallet action has its own switch (QWAKK_NATIVE_ACTIONS).
  const features = useFeatures();
  const nativeActions = features.actions.swap;
  // Write paths wait for /api/features: until then the asset registry is the default (testnet) one.
  const networkReady = features.network !== null;
  const tx = useNativeTransaction();
  const [walletAddress, setWalletAddress] = useState("");
  // The quote the trader reviewed, frozen when Review is clicked. Auto-refresh
  // never changes it; confirm compares the fresh quote against it.
  const [reviewed, setReviewed] = useState<QuoteEntry | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reviewNotice, setReviewNotice] = useState("");
  const [quoteVersion, setQuoteVersion] = useState(0);
  const balances = useWalletBalances(walletAddress);
  // On phones the swap card sits above the chart and the pool list.
  const quoteCard = useRef<HTMLElement>(null);

  // Any pool pair works: curated tokens resolve at once, others from the chain's bank metadata.
  const resolveAsset = useAssets(pools.flatMap((pool) => [poolDenom(pool, "a"), poolDenom(pool, "b")]));
  /**
   * Low-liquidity pools by id, with the reason. The indexer's flag is the
   * primary source. A pool the indexer has not reported (indexer down,
   * loading, or behind) is checked locally from the chain reserves with the
   * same dust rule, so a dust or empty pool is never offered for review.
   */
  const lowLiquidityById = useMemo(() => {
    // Rows survive a failed refresh (useMarkets keeps the last good list), so only missing rows fall back.
    const indexed = new Map(markets.map((market) => [String(market.id), market]));
    const flagged = new Map<string, string | null>();
    for (const pool of pools) {
      const id = poolId(pool);
      const row = indexed.get(id);
      if (row) {
        if (isLowLiquidity(row)) flagged.set(id, row.low_liquidity_reason ?? null);
        continue;
      }
      const local = localLiquidityReason(pool.reserve_a, pool.reserve_b, resolveAsset(poolDenom(pool, "a")).decimals, resolveAsset(poolDenom(pool, "b")).decimals);
      if (local) flagged.set(id, local);
    }
    return flagged;
  }, [markets, pools, resolveAsset]);
  // The selected pool always stays in the list, even when it is a low-liquidity one.
  const listedPools = useMemo(
    () => showLowLiquidity ? pools : pools.filter((pool) => !lowLiquidityById.has(poolId(pool)) || poolId(pool) === selectedPoolId),
    [pools, showLowLiquidity, lowLiquidityById, selectedPoolId],
  );
  const hiddenPools = pools.length - listedPools.length;
  const searchEntry = useCallback((pool: RawPool): SearchEntry => ({
    id: poolId(pool),
    tokens: [poolDenom(pool, "a"), poolDenom(pool, "b")].map((denom) => {
      const asset = resolveAsset(denom);
      return { denom, symbol: asset.symbol, name: asset.name };
    }),
  }), [resolveAsset]);
  const pickerPools = useMemo(
    () => poolQuery.trim() ? searchPools(listedPools, poolQuery, searchEntry).map((match) => match.item) : listedPools,
    [listedPools, poolQuery, searchEntry],
  );
  // A search that only finds hidden low-liquidity pools says so, instead of claiming the token is not listed.
  const hiddenPickerMatches = poolQuery.trim() && !showLowLiquidity ? searchPools(pools.filter((pool) => !listedPools.includes(pool)), poolQuery, searchEntry).length : 0;
  const selectedPool = useMemo(
    () => pools.find((pool) => poolId(pool) === selectedPoolId) ?? listedPools[0],
    [pools, listedPools, selectedPoolId],
  );
  const denomA = poolDenom(selectedPool, "a");
  const denomB = poolDenom(selectedPool, "b");
  const denomIn = reversed ? denomB : denomA;
  const denomOut = reversed ? denomA : denomB;
  // Every label in this page comes from the same resolved token, so a symbol read from metadata is used consistently.
  const shortDenom = (denom: string) => denom ? resolveAsset(denom).symbol : "Unknown";
  const inputAsset = resolveAsset(denomIn);
  const outputAsset = resolveAsset(denomOut);
  const selectedId = poolId(selectedPool);
  const selectedLowReason = selectedId && lowLiquidityById.has(selectedId) ? lowLiquidityById.get(selectedId) ?? null : undefined;
  const selectedLow = selectedLowReason !== undefined;
  const poolChart = usePoolDetail(selectedId, chartInterval);
  // The selected pool's indexed figures: the detail read when it has landed, the markets list until then.
  const pairMarket: QuoteMarket | null = poolChart.pool ?? markets.find((row) => String(row.id) === selectedId) ?? null;
  // A low-liquidity pool's price is not meaningful, so it is never charted or headlined (the flag can come from either read).
  const chartPoolLow = selectedLow || (pairMarket ? isLowLiquidity(pairMarket) : false);
  const chartSides = poolChart.pool ? marketSides(poolChart.pool) : null;
  const pairSides = pairMarket ? marketSides(pairMarket) : selectedPool ? { base: { denom: denomA, symbol: resolveAsset(denomA).symbol }, quote: { denom: denomB, symbol: resolveAsset(denomB).symbol } } : null;
  const pairPrice = pairMarket && !chartPoolLow ? marketPrice(pairMarket) : null;
  const pairChange = pairMarket && !chartPoolLow ? marketChange(pairMarket) : null;
  const pairVolume = pairMarket ? marketVolume(pairMarket).value : null;
  const pairLiquidity = pairMarket?.tvl_quote === null || pairMarket?.tvl_quote === undefined || pairMarket.tvl_quote === "" ? null : Number(pairMarket.tvl_quote);
  // Dust or empty reserves: no fair price, so review stays off.
  const selectedTooThin = selectedLowReason === "dust_reserve" || selectedLowReason === "empty";
  // Price protection: a preset, or a custom percent from 0.01% to 5%.
  const slippageBps = slippageChoice === "custom" ? parseSlippagePercent(customSlippage) : Number(slippageChoice);
  // Exact out only where QoreChain quotes it: constant-product pools (the server checks again).
  const exactOutSupported = supportsExactOut(selectedPool);
  // A pool without exact-out quotes always quotes from the pay side, even if it became the selection on its own.
  const exactOut = fixedSide === "out" && exactOutSupported;
  // The typed side: what the trader pays (exact in) or receives (exact out), in base units.
  const amountCheck = exactOut
    ? checkAmount(receiveAmount, denomOut ? outputAsset.decimals : 6, outputAsset.symbol)
    : checkAmount(amount, denomIn ? inputAsset.decimals : 6, inputAsset.symbol);
  // Display decimals. Unknown output decimals block the swap below, so these only shape text.
  const inputDecimals = inputAsset.decimals ?? 0;
  const outputDecimals = outputAsset.decimals ?? 0;
  const decimalsKnown = inputAsset.decimals !== null && outputAsset.decimals !== null;
  const amountBase = amountCheck.base;
  const amountError = amountCheck.error;
  const quoteParams = (base: string, bps: number): QuoteParams => exactOut
    ? { poolId: selectedId, denomIn, amountOut: base, slippageBps: bps }
    : { poolId: selectedId, denomIn, amountIn: base, slippageBps: bps };
  const currentKey = selectedPool && denomIn && amountCheck.base && slippageBps !== null
    ? quoteKey(quoteParams(amountCheck.base, slippageBps))
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
      // Without a request, the first pool that is not low liquidity is picked once market data arrives (see below).
      setSelectedPoolId((current) => nextPools.some((pool) => poolId(pool) === current) ? current : nextPools.some((pool) => poolId(pool) === requested) ? requested : "");
      setNetworkState("ready");
      setCheckedAt(new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date()));
    } catch {
      setNetworkState("unavailable");
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
      const params: QuoteParams = exactOut
        ? { poolId: selectedId, denomIn, amountOut: amountBase, slippageBps }
        : { poolId: selectedId, denomIn, amountIn: amountBase, slippageBps };
      const key = quoteKey(params);
      try {
        const data = await requestQuote(params, controller.signal);
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
  }, [amountBase, amountError, denomIn, denomOut, exactOut, selectedId, selectedPool, slippageBps, quoteVersion]);

  // Keep the quote current while it is on screen, but not while the trader
  // reviews it or a transaction is running: the reviewed numbers stay put.
  const hasQuote = Boolean(quote);
  useEffect(() => {
    if (!hasQuote || reviewing || tx.busy || confirming) return;
    const timer = window.setInterval(() => setQuoteVersion((value) => value + 1), QUOTE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasQuote, reviewing, tx.busy, confirming]);

  // The search dialog opens a pool here without leaving the page (a same-page link keeps this page mounted).
  useEffect(() => {
    const onSelect = (event: Event) => {
      const id = String((event as CustomEvent<string>).detail ?? "");
      const pool = pools.find((candidate) => poolId(candidate) === id);
      if (!pool) return;
      setSelectedPoolId(id);
      setReversed(false);
      if (!supportsExactOut(pool)) setFixedSide("in");
      setReviewed(null);
      setReviewNotice("");
    };
    window.addEventListener(SELECT_POOL_EVENT, onSelect);
    return () => window.removeEventListener(SELECT_POOL_EVENT, onSelect);
  }, [pools]);

  function selectPool(pool: RawPool) {
    setSelectedPoolId(poolId(pool));
    setReversed(false);
    if (!supportsExactOut(pool)) setFixedSide("in");
    setReviewed(null);
    setReviewNotice("");
    // The list is below the swap card on phones, so bring the card back into view.
    const card = quoteCard.current;
    // Its scroll margin is the height of the sticky top bar and ticker, so anything above it is hidden.
    if (card && window.matchMedia("(max-width: 1080px)").matches && card.getBoundingClientRect().top < parseFloat(getComputedStyle(card).scrollMarginTop)) {
      card.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    }
  }

  function editInputs(update: () => void) {
    update();
    setReviewed(null);
    setReviewNotice("");
  }

  /** Typing in one amount fixes that side; the other side is quoted. */
  function typeAmount(side: FixedSide, next: string) {
    editInputs(() => {
      setFixedSide(side);
      if (side === "in") setAmount(next);
      else setReceiveAmount(next);
      setClampedAmount("");
    });
  }

  /**
   * Switches the tokens. The typed number stays with its token, as on other
   * DEXes: 10 QOR paid becomes 10 QOR received, and the other side is quoted.
   * A pool without exact-out quotes keeps the number on the pay side.
   */
  function flipTokens() {
    setFlipTurns((turns) => turns + 1);
    editInputs(() => {
      setReversed((current) => !current);
      setClampedAmount("");
      if (exactOut) {
        setAmount(receiveAmount);
        setFixedSide("in");
      } else if (exactOutSupported) {
        setReceiveAmount(amount);
        setFixedSide("out");
      }
    });
  }

  /**
   * Re-quotes at sign time. The swap is signed only if the fresh quote still
   * guarantees at least the minimum the trader reviewed (exact in), or still
   * delivers the same amount for no more than the reviewed maximum (exact
   * out); otherwise the new numbers go back on screen for another review.
   */
  async function confirmSwap() {
    if (!reviewed || !reviewedQuote || !selectedPool || confirming || tx.busy || slippageBps === null || !amountCheck.base || !decimalsKnown || !networkReady || selectedTooThin) return;
    const params = quoteParams(amountCheck.base, slippageBps);
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
    if (exactOut) {
      if (requoteExactOutDecision(reviewedQuote, fresh) === "review") {
        setConfirming(false);
        setReviewed(fresh.blocked || fresh.mode !== "exact_out" ? null : { key: reviewed.key, data: fresh });
        setReviewNotice(fresh.blocked ? QUOTE_BLOCK_COPY[fresh.blocked] : "The price moved since you reviewed it. Check the new maximum, then confirm again.");
        return;
      }
      setConfirming(false);
      void tx.run({ kind: "swap", mode: "exact_out", poolId: selectedId, denomIn, amountIn: fresh.totalAmountIn, denomOut, amountOut: fresh.amountOut, maxIn: fresh.maxIn });
      return;
    }
    // Never sign with a minimum of nothing.
    if (!fresh.blocked && fresh.minOut === "0") {
      setConfirming(false);
      setReviewed(null);
      setReviewNotice(QUOTE_ZERO_OUT_COPY);
      return;
    }
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

  // The quoted side. Unknown decimals get their own state, so it never looks like a quote that is still loading.
  // A non-zero amount never shows as 0 (formatVisibleAmount adds digits or shows "< 0.0…1").
  const quotedAsset = exactOut ? inputAsset : outputAsset;
  const quotedDenom = exactOut ? denomIn : denomOut;
  const quotedAmount = quote ? exactOut ? quote.totalAmountIn : quote.amountOut : "";
  const quotedText = quote && quotedAsset.decimals !== null ? formatVisibleAmount(quotedAmount, exactOut ? inputDecimals : outputDecimals, 6) : "";
  const quotedPlaceholder = quote && quotedAsset.decimals === null ? "Unknown" : quoteState === "loading" ? "…" : "0.0";
  const payText = exactOut ? quotedText : amount;
  const receiveText = exactOut ? receiveAmount : quotedText;
  // Quote errors and review notices are fixed copy (ours or the route's); copy() names this deployment's network in them.
  const quotedHint = quoteState === "unavailable" ? copy(quoteError) : !selectedPool ? (hiddenPools > 0 ? "Pick a pool to get a quote." : copy("A quote appears once QoreChain Diana has a pool.")) : quotedDenom && quotedAsset.decimals === null ? assetDecimalsUnknownCopy(quotedAsset.symbol) : quote?.source === "estimate" ? copy("Estimated from pool reserves. The QoreChain Diana quote service did not answer.") : copy(`Quoted by QoreChain Diana in ${shortDenom(quotedDenom)}`);
  // Exact out: the balance must cover the most the swap can take (interface fee plus maxIn).
  const spendAmount = exactOut ? quote && !quote.blocked && quote.mode === "exact_out" ? quote.maxTotalIn : "" : amountCheck.base;
  const enoughBalance = balances && spendAmount ? coversSpend({ balances, spend: [{ denom: denomIn, amount: spendAmount }] }) : null;
  // The shown impact leaves out the pool fee (its own row) and the rounding of a tiny output, which do not move the price.
  const impactHigh = quote?.curveImpactBps !== null && quote?.curveImpactBps !== undefined && quote.curveImpactBps >= IMPACT_WARN_BPS;
  // Over the impact cap: the largest amount on the typed side that fits (pay in, or receive out).
  const maxLimit = quote?.blocked !== "impact" ? "" : quote.mode === "exact_out" ? quote.maxAmountOut ?? "" : quote.maxAmountIn ?? "";
  const maxHint = maxLimit && maxLimit !== "0" ? maxLimit : "";
  const maxDecimals = exactOut ? outputDecimals : inputDecimals;
  const maxText = maxHint ? `${formatVisibleAmount(maxHint, maxDecimals, 6)} ${shortDenom(exactOut ? denomOut : denomIn)}` : "";
  // A blocked swap that the pool's one-swap limit explains says so plainly, with the largest amount it takes.
  const blockCopy = quote?.blocked === "impact" && maxText
    ? exactOut ? `This pool is too small for that amount: the most you can receive here in one go is about ${maxText}.` : `This pool is too small for that amount: the most you can swap here in one go is about ${maxText}.`
    : quote?.blocked ? copy(QUOTE_BLOCK_COPY[quote.blocked]) : "";
  const zeroOut = Boolean(quote && !quote.blocked && quote.minOut === "0");
  const clamped = Boolean(clampedAmount) && clampedAmount === `${fixedSide}:${exactOut ? receiveAmount : amount}`;
  const canReview = Boolean(networkReady && quote && !quote.blocked && !zeroOut && !selectedTooThin && enoughBalance !== false && decimalsKnown);
  const inputHint = `Enter ${shortDenom(denomIn || "uqor")}. Converted to the on-chain unit for you.`;
  const receiveHint = `Enter ${shortDenom(denomOut || "uqor")}. You get exactly this amount, and what you pay is quoted.`;
  // The quote comes from the same server fee configuration that prepares the transaction.
  const feeSource = quote?.interfaceFee ?? (feeConfig && feeConfig !== "unknown" ? feeConfig : null);
  const feeLabel = feeSource ? (feeSource.enabled && feeSource.feeBps > 0 ? `${(feeSource.feeBps / 100).toFixed(2)}%` : "None") : feeConfig === "unknown" ? "Shown with the quote" : "Checking…";
  const readiness = networkState === "checking" ? `Checking ${networkLabel}` : networkState === "unavailable" ? `${networkLabel} is unavailable` : listedPools.length ? "Live quotes from the native AMM" : pools.length ? "Only low-liquidity pools are open" : `No ${networkLabel} pool is open yet`;
  const lastUpdated = networkState === "checking" ? `Checking ${networkLabel} markets` : networkState === "unavailable" ? `${networkLabel} markets are temporarily unavailable` : `${networkLabel} checked ${checkedAt}`;
  const change = market.data?.change24h ?? null;

  // Quick amounts: shares of the spendable balance once it is known (QOR keeps the network fee
  // reserve), otherwise presets sized for the token. None while the token's decimals are unknown.
  const balanceIn = balances && denomIn ? balances.get(denomIn) ?? BigInt(0) : null;
  const spendable = balanceIn === null ? null : denomIn === "uqor" ? (balanceIn > NETWORK_FEE_RESERVE_UQOR ? balanceIn - NETWORK_FEE_RESERVE_UQOR : BigInt(0)) : balanceIn;
  const quickAmounts: Array<{ label: string; value: string }> = inputAsset.decimals === null || !denomIn
    ? []
    : walletAddress && spendable !== null && spendable > BigInt(0)
      ? BALANCE_SHARES.map(({ label, percent }) => ({ label, value: formatBaseAmount(((spendable * BigInt(percent)) / BigInt(100)).toString(), inputAsset.decimals as number, inputAsset.decimals as number) })).filter((option) => option.value !== "0")
      : (QUICK_AMOUNTS_BY_SYMBOL[inputAsset.symbol] ?? []).map((value) => ({ label: new Intl.NumberFormat("en-US").format(Number(value)), value }));

  return <div className="app-shell">
    <QwakkHeader page="swap" />
    <main className="app-main">
      <div className="container trade-grid">
        <div className="trade-main">
          <section className="panel pair-bar" aria-label="Selected pool">
            {pairSides
              ? <>
                <div className="pair-title">
                  <span className="coin-avatar"><TokenIcon denom={pairSides.base.denom} size="avatar" /><span className="coin-badge"><TokenIcon denom={pairSides.quote.denom} size="small" /></span></span>
                  <div><b>{pairSides.base.symbol} <span className="subtle">/ {pairSides.quote.symbol}</span></b><span className="cell-sub">Pool #{selectedId} on {networkLabel}</span></div>
                </div>
                <div className="pair-quote">
                  <div className="pair-price num">{chartPoolLow ? <span className="is-muted">Not shown</span> : pairPrice !== null ? <>{formatQuotePrice(pairPrice)}<small className="pair-unit">{pairSides.quote.symbol}</small></> : pairMarket ? "No swaps yet" : poolChart.state === "unavailable" ? "Not available" : "…"}</div>
                  {pairChange !== null && <span className={`change-pill ${pairChange < 0 ? "is-down" : "is-up"}`}>{formatChange(pairChange)} 24h</span>}
                </div>
                <div className="pair-stats">
                  <div className="stat"><span className="stat-label">24h volume</span><span className="stat-value num">{pairMarket ? pairVolume === null ? "None yet" : poolAmount(pairVolume, pairSides.quote.symbol) : "Not available"}</span></div>
                  <div className="stat"><span className="stat-label">Liquidity</span><span className="stat-value num">{pairLiquidity === null ? "Not available" : poolAmount(pairLiquidity, pairSides.quote.symbol)}</span></div>
                </div>
              </>
              : <div className="pair-title"><div><b>No pool selected</b><span className="cell-sub">{listedPools.length ? "Pick a pool below to see its price." : copy("A quote appears once QoreChain Diana has a pool.")}</span></div></div>}
          </section>

          <section className="panel" aria-labelledby="chart-title">
            <div className="panel-head chart-head">
              <div>
                <span className="panel-title" id="chart-title">{chartView === "qor" ? "QOR price in USD" : chartSides ? `${chartSides.base.symbol} price in ${chartSides.quote.symbol}` : "Pool price"}</span>
                <span className="cell-sub">{chartView === "qor"
                  ? market.data ? `${formatUsdPrice(market.data.price)} now, ${formatChange(change)} in 24h` : "From CoinGecko"
                  : poolChart.pool ? `${priceUnit(poolChart.pool)}, ${CHART_INTERVAL_LABELS[chartInterval].toLowerCase()}` : CHART_INTERVAL_LABELS[chartInterval]}</span>
              </div>
              {chartView === "pool"
                ? <ChartIntervalTabs value={chartInterval} onChange={setChartInterval} />
                : <div className="segmented" role="group" aria-label="Chart range">{MARKET_RANGES.map((option) => <button type="button" key={option} aria-pressed={option === range} onClick={() => setRange(option)}>{MARKET_RANGE_LABELS[option]}</button>)}</div>}
            </div>
            {chartView === "qor"
              ? market.data && market.data.points.length > 1
                ? <PriceChart points={market.data.points} dimmed={market.status === "refreshing"} />
                : <div className="chart-empty" style={{ height: 360 }}>{market.status === "unavailable" ? "QOR market data is temporarily unavailable." : "Loading QOR market data…"}</div>
              : !selectedId
                ? <ChartMessage>Pick a pool to see its price chart.</ChartMessage>
                : chartPoolLow
                  ? <ChartMessage>No chart for this pool: it holds too little to give a meaningful price.</ChartMessage>
                  : poolChart.candles.length > 0 && poolChart.interval
                    // While another interval loads, the last one stays on screen, dimmed.
                    ? <PoolChart candles={poolChart.candles} interval={poolChart.interval} unit={poolChart.pool ? priceUnit(poolChart.pool) : "pool price"} quoteSymbol={chartSides?.quote.symbol ?? ""} resetKey={`${selectedId}|${poolChart.interval}`} loading={poolChart.state === "loading"} />
                    : poolChart.state === "ready"
                      ? <ChartMessage>{chartEmptyCopy(chartInterval)}</ChartMessage>
                      : poolChart.state === "unavailable" || poolChart.state === "missing"
                        ? <ChartMessage>The pool chart is temporarily unavailable. It retries on its own.</ChartMessage>
                        : <ChartMessage loading>Loading the pool chart…</ChartMessage>}
            <div className="panel-note chart-note">
              <div className="segmented" role="group" aria-label="Chart">
                <button type="button" aria-pressed={chartView === "pool"} onClick={() => setChartView("pool")}>Pool price</button>
                <button type="button" aria-pressed={chartView === "qor"} onClick={() => setChartView("qor")}>QOR price in USD</button>
              </div>
              <span>{chartView === "qor"
                ? <>QOR market across exchanges, from <a href="https://www.coingecko.com/en/coins/qorechain" target="_blank" rel="noreferrer">CoinGecko</a>.{` Pool prices on ${networkLabel} can differ.`}</>
                : <>{`Prices from trades in this pool on ${networkLabel}.`}{selectedId && <> <Link href={`/pools/${selectedId}`}>Pool details</Link></>}</>}</span>
            </div>
          </section>

          {/* Keyed by pool, so a switched pool starts on its newest swaps. */}
          {poolChart.pool && <RecentSwaps key={selectedId} pool={poolChart.pool} swaps={poolChart.swaps} pageSize={5} titleId="pool-swaps-title" />}

          <section className="panel" aria-labelledby="pools-title">
            <div className="panel-head"><span className="panel-title" id="pools-title">{`${networkLabel} pools`}</span><span className="subtle"><span className={`dot ${networkState === "ready" ? "live" : ""}`} /> {lastUpdated}</span></div>
            {pools.length > 0 && <div className="picker-search">
              <label className="search"><Search size={16} aria-hidden="true" /><input type="search" value={poolQuery} onChange={(event) => setPoolQuery(event.target.value)} placeholder="Token, pool # or address" aria-label="Filter pools by token name, symbol, pool number or contract address" autoComplete="off" spellCheck={false} /></label>
            </div>}
            {pickerPools.length ? <div className="table">{pickerPools.map((pool, index) => {
              const id = poolId(pool) || String(index + 1);
              const tokenA = poolDenom(pool, "a");
              const tokenB = poolDenom(pool, "b");
              const selected = id === poolId(selectedPool);
              return <button type="button" className={`table-row pool-pick ${selected ? "is-selected" : ""}`} key={id} onClick={() => selectPool(pool)} aria-pressed={selected}>
                <span className="cell-main"><span className="pair-icons"><TokenIcon denom={tokenA} size="regular" /><TokenIcon denom={tokenB} size="regular" /></span><span><b>{shortDenom(tokenA)} / {shortDenom(tokenB)}</b><small>{poolKind(pool)}{lowLiquidityById.has(id) && <span className="low-tag">Low liquidity</span>}</small></span></span>
                <span className="subtle mono">#{id}</span>
              </button>;
            })}</div> : listedPools.length > 0 && poolQuery.trim() ? hiddenPickerMatches > 0 ? <div className="empty">
              <span className="empty-icon"><Layers size={18} /></span>
              <h3>Only low-liquidity pools match</h3>
              <p>{hiddenPickerMatches === 1 ? "One pool matches, but it holds too little to trade at a fair price." : `${hiddenPickerMatches} pools match, but each holds too little to trade at a fair price.`}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLowLiquidity(true)}>Show low-liquidity pools</button>
            </div> : <div className="empty">
              <span className="empty-icon"><Search size={18} /></span>
              <h3>{searchEmptyCopy(poolQuery, BRAND.name).title}</h3>
              <p>{searchEmptyCopy(poolQuery, BRAND.name).body}</p>
            </div> : hiddenPools > 0 ? <div className="empty">
              <span className="empty-icon"><Layers size={18} /></span>
              <h3>Only low-liquidity pools are open</h3>
              <p>{hiddenPools === 1 ? "One pool is open, but it holds too little to trade at a fair price." : `${hiddenPools} pools are open, but each holds too little to trade at a fair price.`}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowLowLiquidity(true)}>Show low-liquidity pools</button>
            </div> : <div className="empty">
              <span className="empty-icon"><Layers size={18} /></span>
              <h3>No pools are open yet</h3>
              <p>{copy("QoreChain Diana has no native AMM pool right now. This list and the quote card update on their own when the first one opens.")}</p>
              <Link className="btn btn-ghost btn-sm" href="/pools">View all markets</Link>
            </div>}
            {lowLiquidityById.size > 0 && (listedPools.length > 0 || showLowLiquidity) && <label className="check-toggle panel-toggle"><input type="checkbox" checked={showLowLiquidity} onChange={(event) => setShowLowLiquidity(event.target.checked)} />Show low-liquidity pools</label>}
          </section>
        </div>

        <aside ref={quoteCard} className="panel quote-card" aria-labelledby="quote-title">
          <div className="panel-head"><span className="panel-title" id="quote-title">{nativeActions ? "Swap" : "Quote"}</span><span className="kicker">Native AMM</span></div>
          <div className="panel-body">
            <div className="quote-field">
              <span className="quote-field-top"><span>You pay</span>{quickAmounts.length > 0 && <span className="quick-amounts" role="group" aria-label="Quick amounts">{quickAmounts.map((option) => <button type="button" key={option.label} aria-pressed={!exactOut && amount === option.value} disabled={tx.busy || confirming} onClick={() => typeAmount("in", option.value)}>{option.label}</button>)}</span>}</span>
              <span className="quote-field-row"><input aria-label={`Amount to pay in ${shortDenom(denomIn || "uqor")}`} className={[exactOut && quoteState === "loading" ? "is-pending" : "", amountSize(payText || (exactOut ? quotedPlaceholder : "")) ?? ""].filter(Boolean).join(" ") || undefined} inputMode="decimal" placeholder={exactOut ? quotedPlaceholder : "0.0"} value={payText} disabled={tx.busy || confirming} onChange={(event) => typeAmount("in", event.target.value)} /><span className="token-chip"><TokenIcon denom={denomIn || "uqor"} size="small" />{shortDenom(denomIn || "uqor")}</span></span>
              <span className={`quote-hint ${exactOut && quoteState === "unavailable" ? "is-error" : ""}`} aria-live="polite">{exactOut ? quotedHint : inputHint}</span>
              {walletAddress && enoughBalance === false && <>
                <span className="quote-hint is-error">{exactOut
                  ? denomIn === "uqor" ? "Not enough QOR for the most this swap can cost plus the network fee." : `Not enough ${shortDenom(denomIn)} for the most this swap can cost, or not enough QOR for the network fee.`
                  : denomIn === "uqor" ? "Not enough QOR for this amount plus the network fee." : `Not enough ${shortDenom(denomIn)} for this amount, or not enough QOR for the network fee.`}</span>
                <FaucetHint />
              </>}
              {clamped && !exactOut && <span className="quote-hint">Set to the most this pool takes in one swap. A bigger amount would move its price past the chain&apos;s limit.</span>}
            </div>
            <button type="button" className="quote-switch" aria-label="Switch tokens" disabled={!selectedPool || tx.busy || confirming} style={{ "--flip": `${flipTurns * 180}deg` } as CSSProperties} onClick={flipTokens}><ArrowDownUp size={18} aria-hidden="true" /></button>
            <div className="quote-field">
              <span className="quote-field-top"><span>You receive</span></span>
              <span className="quote-field-row"><input aria-label={`Amount to receive in ${shortDenom(denomOut || "uqor")}`} title={receiveText || undefined} className={[!exactOut && quoteState === "loading" ? "is-pending" : "", amountSize(receiveText || (exactOut ? "" : quotedPlaceholder)) ?? ""].filter(Boolean).join(" ") || undefined} inputMode="decimal" placeholder={exactOut ? "0.0" : quotedPlaceholder} value={receiveText} disabled={!denomOut || !exactOutSupported || tx.busy || confirming} onChange={(event) => typeAmount("out", event.target.value)} />{denomOut ? <span className="token-chip"><TokenIcon denom={denomOut} size="small" />{shortDenom(denomOut)}</span> : <span className="token-chip subtle">Select a pool</span>}</span>
              <span className={`quote-hint ${!exactOut && quoteState === "unavailable" ? "is-error" : ""}`} aria-live="polite">{exactOut ? receiveHint : quotedHint}</span>
              {clamped && exactOut && <span className="quote-hint">Set to the most this pool pays out in one swap. A bigger amount would move its price past the chain&apos;s limit.</span>}
            </div>
            {/* One notice slot under the amounts: a too-thin pool, a blocked quote (with the largest amount the pool takes), nothing to receive, or a high price impact. */}
            {selectedLow && <div className="quote-alert">
              <p className="quote-alert-text"><AlertTriangle size={14} aria-hidden="true" /><span>{selectedTooThin ? "This pool is too thin to trade. " : ""}{lowLiquidityCopy(selectedLowReason)}</span></p>
            </div>}
            {!selectedTooThin && (blockCopy || zeroOut || (impactHigh && !quote?.blocked)) && <div className="quote-alert">
              <p className="quote-alert-text"><AlertTriangle size={14} aria-hidden="true" /><span>{blockCopy
                ? blockCopy
                : zeroOut ? QUOTE_ZERO_OUT_COPY
                : <>This swap moves the pool price by {percent(quote?.curveImpactBps ?? 0)}. You get noticeably less than the current price.</>}</span></p>
              {maxHint && <button type="button" className="btn btn-ghost btn-sm" disabled={tx.busy || confirming} onClick={() => { const next = formatBaseAmount(maxHint, maxDecimals, maxDecimals); typeAmount(fixedSide, next); setClampedAmount(`${fixedSide}:${next}`); }}>{exactOut ? "Receive the most" : "Swap the most"}: {maxText}</button>}
            </div>}
            <div className="quote-meta">
              <div className="quote-meta-row"><span>Price impact</span><b className={`num ${impactHigh ? "down" : ""}`}>{quote ? quote.curveImpactBps === null ? `Checked by ${networkLabel}` : quote.curveImpactBps === 0 ? "Under 0.01%" : percent(quote.curveImpactBps) : "Not available"}</b></div>
              {exactOut
                ? <div className="quote-meta-row"><span>Maximum you pay</span><b className="num">{quote && !quote.blocked && quote.mode === "exact_out" && inputAsset.decimals !== null ? `${formatVisibleAmount(quote.maxTotalIn, inputDecimals, 6)} ${shortDenom(denomIn)}` : "Not available"}</b></div>
                : <div className="quote-meta-row"><span>Minimum received</span><b className="num">{quote && !quote.blocked && outputAsset.decimals !== null ? `${formatVisibleAmount(quote.minOut, outputDecimals, 6)} ${shortDenom(denomOut)}` : "Not available"}</b></div>}
              <div className="quote-meta-row"><span>Pool fee</span><b className="num">{quote ? `${formatVisibleAmount(quote.nativeAmmFee, inputDecimals, 6)} ${shortDenom(denomIn)}` : "Not available"}</b></div>
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
                    {reviewedQuote.mode === "exact_out"
                      ? <p className="review-line">You receive exactly <b>{formatVisibleAmount(reviewedQuote.amountOut, outputDecimals, 6)} {shortDenom(denomOut)}</b> and pay about <b>{formatVisibleAmount(reviewedQuote.totalAmountIn, inputDecimals, 6)} {shortDenom(denomIn)}</b>, never more than <b>{formatVisibleAmount(reviewedQuote.maxTotalIn, inputDecimals, 6)} {shortDenom(denomIn)}</b>.{reviewedQuote.interfaceFee.enabled && reviewedQuote.interfaceFee.amount !== "0" && <> This includes a <b>{formatVisibleAmount(reviewedQuote.interfaceFee.amount, inputDecimals, 6)} {shortDenom(denomIn)}</b> interface fee.</>}</p>
                      : <p className="review-line">You pay <b>{formatVisibleAmount(reviewedQuote.totalAmountIn, inputDecimals, 6)} {shortDenom(denomIn)}</b> and receive at least <b>{formatVisibleAmount(reviewedQuote.minOut, outputDecimals, 6)} {shortDenom(denomOut)}</b>.{reviewedQuote.interfaceFee.enabled && reviewedQuote.interfaceFee.amount !== "0" && <> This includes a <b>{formatVisibleAmount(reviewedQuote.interfaceFee.amount, inputDecimals, 6)} {shortDenom(denomIn)}</b> interface fee.</>}</p>}
                    {reviewNotice && <p className="quote-hint is-error" role="alert">{copy(reviewNotice)}</p>}
                    <div className="review-actions">
                      <button type="button" className="btn btn-ghost btn-lg" disabled={confirming} onClick={() => { setReviewed(null); setReviewNotice(""); }}>Edit</button>
                      <button type="button" className="btn btn-primary btn-lg" disabled={confirming || !canReview} onClick={() => void confirmSwap()}>{confirming ? "Checking the price…" : "Confirm in QoreX"}</button>
                    </div>
                  </div>
                  : !walletAddress
                    ? <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>
                    : <>
                      {reviewNotice && <p className="quote-hint is-error" role="alert">{copy(reviewNotice)}</p>}
                      <button type="button" className="btn btn-primary btn-block btn-lg" disabled={!canReview} onClick={() => { if (quote && currentKey) setReviewed({ key: currentKey, data: quote }); setReviewNotice(""); }}>{selectedTooThin ? "Pool too thin to trade" : quote?.blocked === "impact" ? "Too large for this pool" : quote?.blocked === "paused" ? "Pool paused" : quote?.blocked ? "Swap unavailable" : zeroOut ? "Amount too small" : enoughBalance === false ? `Not enough ${shortDenom(denomIn)}` : quote ? "Review swap" : !selectedPool ? "No pool selected" : quoteState === "loading" ? "Getting a quote…" : "Quote unavailable"}</button>
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
