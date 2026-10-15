"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { useWalletBalances } from "./useWalletBalances";
import { assetForDenom, displaySymbol, formatBaseAmount, toBaseAmount } from "../lib/qwakk-assets";
import { formatRatio } from "../lib/qwakk-amm-math";
import { coversSpend } from "../lib/qwakk-quote";

type AmmInfo = { poolCreationFee: string | null; minLiquidity: string | null } | null;

function decimalsFor(denom: string) {
  return assetForDenom(denom)?.decimals ?? 0;
}

function safeBase(value: string, denom: string) {
  try {
    return denom ? toBaseAmount(value, decimalsFor(denom)) : "";
  } catch {
    return "";
  }
}

/** Seeds a new native AMM pool from two tokens the connected wallet holds. */
export function CreatePoolPanel({ walletAddress, amm }: { walletAddress: string; amm: AmmInfo }) {
  const tx = useNativeTransaction();
  const balances = useWalletBalances(walletAddress);
  const [poolType, setPoolType] = useState<"constant_product" | "stable_swap">("constant_product");
  const [denomA, setDenomA] = useState("uqor");
  const [denomB, setDenomB] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [amplification, setAmplification] = useState("200");
  const [error, setError] = useState("");
  const [existingPoolId, setExistingPoolId] = useState("");
  const [checking, setChecking] = useState(false);

  const options = balances ? [...balances].filter(([, amount]) => amount > BigInt(0)).map(([denom]) => denom) : [];
  const balanceOf = (denom: string) => (balances?.get(denom) ?? BigInt(0)).toString();
  const creationFee = amm?.poolCreationFee && /^\d+$/.test(amm.poolCreationFee) ? BigInt(amm.poolCreationFee) : null;
  const minLiquidity = amm?.minLiquidity && /^\d+$/.test(amm.minLiquidity) ? BigInt(amm.minLiquidity) : null;

  const baseA = safeBase(amountA, denomA);
  const baseB = safeBase(amountB, denomB);
  const pairReady = Boolean(denomA && denomB && denomA !== denomB && baseA && baseB);
  const priceAB = pairReady ? formatRatio(baseB, decimalsFor(denomB), baseA, decimalsFor(denomA), 6) : null;
  const priceBA = pairReady ? formatRatio(baseA, decimalsFor(denomA), baseB, decimalsFor(denomB), 6) : null;

  function minLiquidityText(denom: string) {
    if (minLiquidity === null) return "";
    const decimals = decimalsFor(denom);
    return decimals ? `${formatBaseAmount(minLiquidity.toString(), decimals, decimals)} ${displaySymbol(denom)}` : `${minLiquidity} ${denom} base units`;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || tx.busy) return;
    setError("");
    setExistingPoolId("");
    if (!denomA || !denomB || denomA === denomB) return setError("Choose two different tokens.");
    let depositA: string;
    let depositB: string;
    try {
      depositA = toBaseAmount(amountA, decimalsFor(denomA));
      depositB = toBaseAmount(amountB, decimalsFor(denomB));
    } catch (reason) {
      return setError(reason instanceof Error ? reason.message : "Enter valid amounts.");
    }
    const amp = Number(amplification);
    if (poolType === "stable_swap" && (!Number.isInteger(amp) || amp < 1 || amp > 5_000)) return setError("Amplification must be a whole number from 1 to 5000.");
    if (creationFee === null || minLiquidity === null) return setError("QoreChain Diana's pool settings could not be read. Try again shortly.");
    // Checked on Diana: each deposit on its own must reach min_liquidity.
    if (BigInt(depositA) < minLiquidity) return setError(`Deposit at least ${minLiquidityText(denomA)}.`);
    if (BigInt(depositB) < minLiquidity) return setError(`Deposit at least ${minLiquidityText(denomB)}.`);
    if (balances && !coversSpend({ balances, spend: [{ denom: denomA, amount: depositA }, { denom: denomB, amount: depositB }], extraUqor: creationFee })) {
      return setError(`This wallet needs both deposits, the ${formatBaseAmount(creationFee.toString(), 6, 6)} QOR pool creation fee and the network fee.`);
    }

    setChecking(true);
    try {
      const response = await fetch(`/api/native/pool?denomA=${encodeURIComponent(denomA)}&denomB=${encodeURIComponent(denomB)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json() as { pool?: { id: string } | null };
      if (data.pool) {
        setExistingPoolId(data.pool.id);
        return setError("A pool for this token pair already exists. Add liquidity to it instead.");
      }
    } catch {
      return setError("QoreChain Diana could not be checked for an existing pool. Try again shortly.");
    } finally {
      setChecking(false);
    }

    void tx.run({ kind: "create_pool", poolType, denomA, amountA: depositA, denomB, amountB: depositB, amplificationCoefficient: poolType === "stable_swap" ? amp : undefined });
  }

  if (tx.state.phase !== "idle") {
    return <section className="panel form-panel" aria-label="Pool creation"><TxProgress state={tx.state} onDone={tx.reset} /></section>;
  }

  const busy = checking || tx.busy;

  return <form className="panel form-panel" onSubmit={submit} aria-labelledby="create-pool-title">
    <div className="panel-head"><span className="panel-title" id="create-pool-title">Choose two tokens</span><span className="subtle">{creationFee !== null ? `Creation fee ${formatBaseAmount(creationFee.toString(), 6, 2)} QOR` : ""}</span></div>
    <div className="panel-body form-grid">
      <label className="field">
        <span>Pool type</span>
        <select value={poolType} disabled={busy} onChange={(event) => setPoolType(event.target.value as typeof poolType)}>
          <option value="constant_product">Standard (constant product)</option>
          <option value="stable_swap">Stable pair</option>
        </select>
      </label>
      {poolType === "stable_swap" && <label className="field">
        <span>Amplification</span>
        <input inputMode="numeric" value={amplification} disabled={busy} onChange={(event) => setAmplification(event.target.value)} />
      </label>}
      {([["A", denomA, setDenomA, amountA, setAmountA], ["B", denomB, setDenomB, amountB, setAmountB]] as const).map(([side, denom, setDenom, value, setValue]) => <div className="field-pair" key={side}>
        <label className="field">
          <span>Token {side}</span>
          <select value={denom} disabled={busy} onChange={(event) => { setDenom(event.target.value); setError(""); setExistingPoolId(""); }}>
            <option value="">Select a token</option>
            {options.map((option) => <option key={option} value={option}>{displaySymbol(option)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount{denom ? ` (${decimalsFor(denom) ? displaySymbol(denom) : `${denom} base units`})` : ""}</span>
          <input inputMode="decimal" value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); setError(""); }} placeholder="0.0" />
          {denom && <small className="subtle">Balance {formatBaseAmount(balanceOf(denom), decimalsFor(denom), 6)}</small>}
        </label>
      </div>)}
      {priceAB && priceBA && <div className="quote-meta-row start-price"><span>Starting price</span><span className="start-price-values num"><b>1 {displaySymbol(denomA)} = {priceAB} {displaySymbol(denomB)}</b><small>1 {displaySymbol(denomB)} = {priceBA} {displaySymbol(denomA)}</small></span></div>}
      {error && <p className="form-error" role="alert">{error}{existingPoolId && <> <Link href={`/pools/${existingPoolId}`}>Open pool #{existingPoolId}</Link></>}</p>}
      <p className="subtle form-note">The first deposit sets the starting price. {minLiquidity !== null ? "Each deposit must reach the pool minimum. " : ""}{creationFee !== null ? `Creating a pool costs ${formatBaseAmount(creationFee.toString(), 6, 2)} QOR on top of both deposits and the network fee.` : ""}</p>
      <button type="submit" className="btn btn-primary" disabled={busy}>{checking ? "Checking QoreChain Diana…" : "Create pool"}</button>
    </div>
  </form>;
}
