"use client";

import { FormEvent, useEffect, useState } from "react";
import { QoraHeader } from "../../components/QoraHeader";
import { TokenIcon } from "../../components/TokenIcon";
import { assetForDenom, displaySymbol, toBaseAmount } from "../../lib/qora-assets";

type PoolPlan = { poolType: string; messageType: string; readyForSignature: boolean };

export default function PoolsPage() {
  const [walletAddress, setWalletAddress] = useState("");
  const [poolType, setPoolType] = useState<"constant_product" | "stable_swap">("constant_product");
  const [denomA, setDenomA] = useState("uqor");
  const [amountA, setAmountA] = useState("");
  const [denomB, setDenomB] = useState("uusdc");
  const [amountB, setAmountB] = useState("");
  const [customDecimalsA, setCustomDecimalsA] = useState("6");
  const [customDecimalsB, setCustomDecimalsB] = useState("6");
  const [amplification, setAmplification] = useState("200");
  const [isPreparing, setIsPreparing] = useState(false);
  const [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<PoolPlan | null>(null);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qora-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qora:wallet-change", restoreWallet);
    return () => window.removeEventListener("qora:wallet-change", restoreWallet);
  }, []);

  async function preparePool(event: FormEvent) {
    event.preventDefault();
    setPlan(null);
    if (!walletAddress) {
      setNotice("Connect your wallet from the header before creating a pool.");
      return;
    }
    setIsPreparing(true);
    setNotice("");
    try {
      const assetA = assetForDenom(denomA);
      const assetB = assetForDenom(denomB);
      const decimalsA = assetA?.decimals ?? Number(customDecimalsA);
      const decimalsB = assetB?.decimals ?? Number(customDecimalsB);
      const response = await fetch("/api/pool-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creator: walletAddress,
          poolType,
          denomA: denomA.trim(),
          amountA: toBaseAmount(amountA, decimalsA),
          denomB: denomB.trim(),
          amountB: toBaseAmount(amountB, decimalsB),
          amplificationCoefficient: poolType === "stable_swap" ? Number(amplification) : 0,
        }),
      });
      const result = await response.json() as PoolPlan & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to prepare pool creation");
      setPlan(result);
      setNotice("Pool details are ready. You will review and approve the transaction in QoreX before anything is sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to prepare pool creation");
    } finally {
      setIsPreparing(false);
    }
  }

  const assetA = assetForDenom(denomA);
  const assetB = assetForDenom(denomB);
  const symbolA = displaySymbol(denomA);
  const symbolB = displaySymbol(denomB);

  return <main className="profile-shell pools-shell">
    <QoraHeader page="pools" onConnected={setWalletAddress} />
    <section className="pools-hero">
      <p className="eyebrow">LIQUIDITY, MADE CLEAR</p>
      <h1>Start a market.<br /><em>Set the first price.</em></h1>
      <p>Deposit two assets to create a QoreChain pool. You set the opening price and receive the pool&apos;s liquidity position.</p>
    </section>

    <section className="pool-builder" aria-label="Create a liquidity pool">
      <form className="pool-form" onSubmit={preparePool}>
        <div className="card-heading"><div><p className="kicker">CREATE A POOL</p><h2>Initial liquidity</h2></div><span className="pool-step">01 / 01</span></div>
        <label className="pool-field"><span>Pool type</span><select value={poolType} onChange={(event) => setPoolType(event.target.value as "constant_product" | "stable_swap")}><option value="constant_product">Standard market</option><option value="stable_swap">Close-value assets</option></select><small>{poolType === "stable_swap" ? "For assets designed to stay near the same value." : "For most token pairs and discovery markets."}</small></label>
        <div className="pool-input-grid">
          <label className="pool-field"><span>First token</span><div className="denom-input"><TokenIcon denom={denomA} size="small" /><input value={denomA} onChange={(event) => setDenomA(event.target.value)} placeholder="uqor" autoCapitalize="none" /></div><small>{assetA ? `${assetA.name} · ${assetA.denom}` : "Enter the native token denom."}</small></label>
          <label className="pool-field"><span>Initial {symbolA} amount</span><input value={amountA} onChange={(event) => setAmountA(event.target.value)} inputMode="decimal" placeholder="1" /><small>{assetA ? `Enter ${symbolA}; Qora converts it for the chain.` : "Choose the token decimals below before continuing."}</small></label>
          {!assetA && <label className="pool-field"><span>{symbolA} decimals</span><input value={customDecimalsA} onChange={(event) => setCustomDecimalsA(event.target.value)} inputMode="numeric" placeholder="6" /><small>Required for tokens not yet listed in Qora.</small></label>}
          <label className="pool-field"><span>Second token</span><div className="denom-input"><TokenIcon denom={denomB} size="small" /><input value={denomB} onChange={(event) => setDenomB(event.target.value)} placeholder="uusdc" autoCapitalize="none" /></div><small>{assetB ? `${assetB.name} · ${assetB.denom}` : "Enter the native token denom."}</small></label>
          <label className="pool-field"><span>Initial {symbolB} amount</span><input value={amountB} onChange={(event) => setAmountB(event.target.value)} inputMode="decimal" placeholder="1" /><small>{assetB ? `Enter ${symbolB}; Qora converts it for the chain.` : "Choose the token decimals below before continuing."}</small></label>
          {!assetB && <label className="pool-field"><span>{symbolB} decimals</span><input value={customDecimalsB} onChange={(event) => setCustomDecimalsB(event.target.value)} inputMode="numeric" placeholder="6" /><small>Required for tokens not yet listed in Qora.</small></label>}
        </div>
        {poolType === "stable_swap" && <label className="pool-field"><span>Price stability setting</span><input value={amplification} onChange={(event) => setAmplification(event.target.value)} inputMode="numeric" /><small>Use this only for close-value asset pairs.</small></label>}
        <button className="primary-button" type="submit" disabled={isPreparing}>{isPreparing ? "Preparing pool…" : walletAddress ? "Review pool creation" : "Connect wallet to continue"}<span>→</span></button>
      </form>
      <aside className="pool-explainer">
        <p className="kicker">WHAT HAPPENS NEXT</p>
        <h2>You stay in control.</h2>
        <ol><li><span>1</span><p>Enter the two assets and the amounts you want to seed.</p></li><li><span>2</span><p>Review the opening ratio before confirming in your wallet.</p></li><li><span>3</span><p>Receive your liquidity position once the transaction is confirmed.</p></li></ol>
        {plan && <div className="pool-plan"><span className="status-dot online" /> <b>Ready for wallet confirmation</b><p>{plan.poolType === "stable_swap" ? "Close-value" : "Standard"} market selected.</p></div>}
      </aside>
    </section>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
  </main>;
}
