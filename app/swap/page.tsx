"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { QoraHeader } from "../../components/QoraHeader";
import { TokenIcon } from "../../components/TokenIcon";
import { assetForDenom, displaySymbol, formatBaseAmount, toBaseAmount } from "../../lib/qora-assets";

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
  const [feeConfig, setFeeConfig] = useState<FeeConfig>({ enabled: false, feeBps: 5 });
  const [networkState, setNetworkState] = useState<NetworkState>("checking");
  const [lastUpdated, setLastUpdated] = useState("Checking QoreChain Diana markets");

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
      setSelectedPoolId((current) => nextPools.some((pool) => poolId(pool) === current) ? current : poolId(nextPools[0]));
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
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/qora-fee", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as FeeConfig;
        setFeeConfig({ enabled: Boolean(data.enabled), feeBps: Number(data.feeBps) || 0 });
      } catch {
        // A missing fee disclosure keeps the interface fee visibly disabled.
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
  }, [amount, denomIn, denomOut, inputDecimals, selectedPool, slippageBps]);

  function selectPool(pool: RawPool) {
    setSelectedPoolId(poolId(pool));
    setReversed(false);
  }

  const output = quote ? formatBaseAmount(quote.amountOut, outputDecimals, 6) : quoteState === "loading" ? "Quoting…" : "Unavailable";
  const outputUnit = outputDecimals === 0 && denomOut ? `${denomOut} base units` : `Estimated ${shortDenom(denomOut)}`;
  const feeBps = quote?.interfaceFee.feeBps ?? feeConfig.feeBps;
  const feeEnabled = quote?.interfaceFee.enabled ?? feeConfig.enabled;
  const feeLabel = feeEnabled ? `${(feeBps / 100).toFixed(2)}%` : "Disabled";
  const readiness = networkState === "checking" ? "Checking QoreChain Diana" : networkState === "unavailable" ? "QoreChain Diana unavailable" : pools.length ? "Live quotes connected" : "Quote engine ready";

  return <main className="profile-shell swap-shell">
    <QoraHeader page="swap" />
    <section className="swap-page-hero"><p className="eyebrow">SIMPLE SWAPS ON QORECHAIN</p><h1>Know your price <em>first.</em></h1><p>Pick a pool on QoreChain Diana for a live on-chain estimate, with price protection and every fee shown up front.</p></section>
    <section className="swap-workspace" aria-label="Swap workspace">
      <div className="swap-card swap-card-expanded">
        <div className="card-heading"><div><p className="kicker">QUOTE</p><h2>Choose your assets</h2></div></div>
        <div className={`swap-readiness ${networkState === "unavailable" ? "offline" : ""}`}><span className={`status-dot small ${networkState === "unavailable" ? "" : "online"}`} /><span>{readiness}</span><b>QORECHAIN DIANA</b></div>
        <label className="amount-box"><span>You send</span><div className="amount-row"><input aria-label={`You send amount in ${shortDenom(denomIn)}`} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><span className="token"><TokenIcon denom={denomIn || "uqor"} size="small" />{shortDenom(denomIn || "uqor")}</span></div><small>{inputDecimals === 0 && denomIn ? `Enter ${denomIn} base units.` : `Enter ${shortDenom(denomIn || "uqor")}. Qora converts it to the on-chain unit.`}</small></label>
        <button type="button" className="flip" aria-label="Switch swap tokens" disabled={!selectedPool} onClick={() => setReversed((current) => !current)}>↓</button>
        <label className="amount-box receive-box"><span>You receive</span><div className="amount-row muted-row"><output>{output}</output><span className="token"><TokenIcon denom={denomOut || "uusdc"} size="small" />{shortDenom(denomOut || "uusdc")}</span></div><small>{quoteState === "unavailable" ? quoteError : selectedPool ? outputUnit : "A live quote will appear once QoreChain Diana has a pool."}</small></label>
        <div className="swap-details"><span>Quote <b>{quoteState === "ready" ? "Live" : quoteState === "loading" ? "Loading" : "Waiting"}</b></span><label>Slippage <select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}><option value={10}>0.10%</option><option value={50}>0.50%</option><option value={100}>1.00%</option></select></label><span>Qora fee <b>{feeLabel}</b></span></div>
      </div>
      <aside className="market-card swap-market-card"><div className="card-heading"><div><p className="kicker">AVAILABLE MARKETS</p><h2>Choose a pool</h2></div><span className="pool-count">{pools.length}</span></div><p className="muted-copy">Select a pool to quote it in the card.</p>{pools.length ? <div className="pool-list">{pools.map((pool, index) => {
        const id = poolId(pool) || String(index + 1);
        const tokenA = poolDenom(pool, "a");
        const tokenB = poolDenom(pool, "b");
        return <button className={`pool-row pool-choice ${id === poolId(selectedPool) ? "selected" : ""}`} type="button" key={id} onClick={() => selectPool(pool)}><span className="pair-icons"><TokenIcon denom={tokenA} size="small" /><TokenIcon denom={tokenB} size="small" /></span><span><b>{shortDenom(tokenA)} / {shortDenom(tokenB)}</b><small>{poolKind(pool)}</small></span><span className="pool-id">#{id}</span></button>;
      })}</div> : <div className="empty-state"><span className="empty-mark">✓</span><h3>Quote engine is connected</h3><p>QoreChain Diana has no AMM pool yet. Qora will detect and quote the first market automatically.</p><Link className="outline-button" href="/pools">View pool status</Link></div>}<p className="freshness"><span className={`status-dot small ${networkState === "unavailable" ? "" : "online"}`} /> {lastUpdated}</p></aside>
    </section>
  </main>;
}
