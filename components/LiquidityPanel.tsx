"use client";

import { FormEvent, useEffect, useState } from "react";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { formatBaseAmount, toBaseAmount } from "../lib/qwakk-assets";
import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit } from "../lib/qwakk-liquidity-math";

/** QoreChain AMM params report lp_token_decimals = 6 on Diana and mainnet. */
const LP_DECIMALS = 6;

export type LiquidityPool = {
  id: string | number;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: string | number;
  token_b_decimals: string | number;
  reserve_a: string;
  reserve_b: string;
  lp_supply?: string | null;
};

function safe<T>(compute: () => T, fallback: T) {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

/** Add or withdraw liquidity with minimums derived from the pool's reserves. */
export function LiquidityPanel({ pool, walletAddress }: { pool: LiquidityPool; walletAddress: string }) {
  const tx = useNativeTransaction();
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [lpInput, setLpInput] = useState("");
  const [lpBalance, setLpBalance] = useState("0");
  const [slippageBps, setSlippageBps] = useState(50);
  const [error, setError] = useState("");

  const decimalsA = Number(pool.token_a_decimals) || 0;
  const decimalsB = Number(pool.token_b_decimals) || 0;
  const supply = /^\d+$/.test(pool.lp_supply ?? "") ? pool.lp_supply as string : "0";

  useEffect(() => {
    if (!walletAddress) return;
    let active = true;
    fetch(`/api/positions?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ positions?: Array<{ poolId: string; lpBalance: string }> }> : null)
      .then((data) => { if (active) setLpBalance(data?.positions?.find((position) => position.poolId === String(pool.id))?.lpBalance ?? "0"); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [walletAddress, pool.id, tx.state.phase]);

  function changeAmountA(value: string) {
    setAmountA(value);
    const matched = safe(() => matchingDeposit(toBaseAmount(value, decimalsA), pool.reserve_a, pool.reserve_b), null);
    setAmountB(matched ? formatBaseAmount(matched, decimalsB, decimalsB) : "");
  }

  const baseA = safe(() => toBaseAmount(amountA, decimalsA), "");
  const baseB = safe(() => toBaseAmount(amountB, decimalsB), "");
  const expectedLp = baseA && baseB ? safe(() => expectedLpForDeposit(baseA, baseB, pool.reserve_a, pool.reserve_b, supply), null) : null;
  const baseLp = safe(() => toBaseAmount(lpInput, LP_DECIMALS), "");
  const withdrawal = baseLp ? safe(() => expectedWithdrawal(baseLp, pool.reserve_a, pool.reserve_b, supply), null) : null;

  function fillPercent(percent: number) {
    const amount = (BigInt(lpBalance) * BigInt(percent)) / BigInt(100);
    setLpInput(formatBaseAmount(amount.toString(), LP_DECIMALS, LP_DECIMALS));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "add") {
      if (!baseA || !baseB) return setError("Enter both amounts.");
      if (!expectedLp) return setError("This pool's reserves could not be read. Try again shortly.");
      void tx.run({ kind: "add_liquidity", poolId: String(pool.id), denomA: pool.token_a, amountA: baseA, denomB: pool.token_b, amountB: baseB, minLpOut: applySlippage(expectedLp, slippageBps) });
      return;
    }
    if (!baseLp) return setError("Enter the share to withdraw.");
    if (BigInt(baseLp) > BigInt(lpBalance)) return setError("This is more than your share of the pool.");
    if (!withdrawal) return setError("This pool's reserves could not be read. Try again shortly.");
    void tx.run({ kind: "remove_liquidity", poolId: String(pool.id), lpAmount: baseLp, minAmountA: applySlippage(withdrawal.amountA, slippageBps), minAmountB: applySlippage(withdrawal.amountB, slippageBps) });
  }

  if (tx.state.phase !== "idle") return <div className="panel-body"><TxProgress state={tx.state} onDone={() => { tx.reset(); setAmountA(""); setAmountB(""); setLpInput(""); }} /></div>;

  return <form className="panel-body form-grid" onSubmit={submit}>
    <div className="segmented" role="group" aria-label="Liquidity action">
      <button type="button" aria-pressed={mode === "add"} onClick={() => { setMode("add"); setError(""); }}>Add</button>
      <button type="button" aria-pressed={mode === "remove"} onClick={() => { setMode("remove"); setError(""); }}>Remove</button>
    </div>
    {mode === "add" ? <>
      <label className="field"><span>{pool.token_a_symbol}</span><input inputMode="decimal" value={amountA} onChange={(event) => changeAmountA(event.target.value)} placeholder="0.0" /></label>
      <label className="field"><span>{pool.token_b_symbol}</span><input inputMode="decimal" value={amountB} onChange={(event) => setAmountB(event.target.value)} placeholder="0.0" /><small className="subtle">Filled at the pool&apos;s current ratio.</small></label>
      <p className="quote-meta-row"><span>Pool share you receive</span><b className="num">{expectedLp ? formatBaseAmount(expectedLp, LP_DECIMALS, 6) : "Not available"}</b></p>
    </> : <>
      <label className="field"><span>Share to withdraw</span><input inputMode="decimal" value={lpInput} onChange={(event) => setLpInput(event.target.value)} placeholder="0.0" /><small className="subtle">You hold {formatBaseAmount(lpBalance, LP_DECIMALS, 6)}</small></label>
      <div className="chip-row">{[25, 50, 100].map((percent) => <button type="button" className="btn btn-ghost btn-sm" key={percent} disabled={lpBalance === "0"} onClick={() => fillPercent(percent)}>{percent}%</button>)}</div>
      <p className="quote-meta-row"><span>You receive about</span><b className="num">{withdrawal ? `${formatBaseAmount(withdrawal.amountA, decimalsA, 6)} ${pool.token_a_symbol} + ${formatBaseAmount(withdrawal.amountB, decimalsB, 6)} ${pool.token_b_symbol}` : "Not available"}</b></p>
    </>}
    <label className="quote-meta-row"><span>Price protection</span><select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))}><option value={10}>0.10%</option><option value={50}>0.50%</option><option value={100}>1.00%</option></select></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="submit" className="btn btn-primary">{mode === "add" ? "Add liquidity" : "Withdraw"}</button>
  </form>;
}
