"use client";

import { FormEvent, useEffect, useState } from "react";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { assetForDenom, displaySymbol, formatBaseAmount, toBaseAmount } from "../lib/qora-assets";

type Balance = { denom: string; amount: string };
type AmmInfo = { poolCreationFee: string | null; minLiquidity: string | null } | null;

function decimalsFor(denom: string) {
  return assetForDenom(denom)?.decimals ?? 0;
}

/** Seeds a new native AMM pool from two tokens the connected wallet holds. */
export function CreatePoolPanel({ walletAddress, amm }: { walletAddress: string; amm: AmmInfo }) {
  const tx = useNativeTransaction();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [poolType, setPoolType] = useState<"constant_product" | "stable_swap">("constant_product");
  const [denomA, setDenomA] = useState("uqor");
  const [denomB, setDenomB] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [amplification, setAmplification] = useState("200");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!walletAddress) return;
    let active = true;
    fetch(`/api/account?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ balances?: Balance[] }> : null)
      .then((data) => { if (active) setBalances((data?.balances ?? []).filter((balance) => /^\d+$/.test(balance.amount) && BigInt(balance.amount) > BigInt(0))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [walletAddress, tx.state.phase]);

  const options = balances.map((balance) => balance.denom);
  const balanceOf = (denom: string) => balances.find((balance) => balance.denom === denom)?.amount ?? "0";

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!denomA || !denomB || denomA === denomB) return setError("Choose two different tokens.");
    let baseA: string;
    let baseB: string;
    try {
      baseA = toBaseAmount(amountA, decimalsFor(denomA));
      baseB = toBaseAmount(amountB, decimalsFor(denomB));
    } catch (reason) {
      return setError(reason instanceof Error ? reason.message : "Enter valid amounts.");
    }
    const amp = Number(amplification);
    if (poolType === "stable_swap" && (!Number.isInteger(amp) || amp < 1 || amp > 5_000)) return setError("Amplification must be a whole number from 1 to 5000.");
    void tx.run({ kind: "create_pool", poolType, denomA, amountA: baseA, denomB, amountB: baseB, amplificationCoefficient: poolType === "stable_swap" ? amp : undefined });
  }

  if (tx.state.phase !== "idle") {
    return <section className="panel form-panel" aria-label="Pool creation"><TxProgress state={tx.state} onDone={tx.reset} /></section>;
  }

  return <form className="panel form-panel" onSubmit={submit} aria-labelledby="create-pool-title">
    <div className="panel-head"><span className="panel-title" id="create-pool-title">Choose two tokens</span><span className="subtle">{amm?.poolCreationFee ? `Creation fee ${formatBaseAmount(amm.poolCreationFee, 6, 2)} QOR` : ""}</span></div>
    <div className="panel-body form-grid">
      <label className="field">
        <span>Pool type</span>
        <select value={poolType} onChange={(event) => setPoolType(event.target.value as typeof poolType)}>
          <option value="constant_product">Standard (constant product)</option>
          <option value="stable_swap">Stable pair</option>
        </select>
      </label>
      {poolType === "stable_swap" && <label className="field">
        <span>Amplification</span>
        <input inputMode="numeric" value={amplification} onChange={(event) => setAmplification(event.target.value)} />
      </label>}
      {([["A", denomA, setDenomA, amountA, setAmountA], ["B", denomB, setDenomB, amountB, setAmountB]] as const).map(([side, denom, setDenom, value, setValue]) => <div className="field-pair" key={side}>
        <label className="field">
          <span>Token {side}</span>
          <select value={denom} onChange={(event) => setDenom(event.target.value)}>
            <option value="">Select a token</option>
            {options.map((option) => <option key={option} value={option}>{displaySymbol(option)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount{denom ? ` (${decimalsFor(denom) ? displaySymbol(denom) : `${denom} base units`})` : ""}</span>
          <input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.0" />
          {denom && <small className="subtle">Balance {formatBaseAmount(balanceOf(denom), decimalsFor(denom), 6)}</small>}
        </label>
      </div>)}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="subtle form-note">The first deposit sets the starting price. {amm?.minLiquidity ? `The pool needs at least ${amm.minLiquidity} base units of each token.` : ""}</p>
      <button type="submit" className="btn btn-primary">Create pool</button>
    </div>
  </form>;
}
