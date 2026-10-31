"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { FaucetHint } from "./FaucetHint";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { useAssets } from "./useAssets";
import { useFeatures } from "./useFeatures";
import { useWalletBalances } from "./useWalletBalances";
import { formatTokenAmount } from "../lib/qwakk-asset-resolve";
import { formatBaseAmount, formatVisibleAmount, toBaseAmount } from "../lib/qwakk-assets";
import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit, poolShareBps, withinTolerance } from "../lib/qwakk-liquidity-math";
import { coversSpend } from "../lib/qwakk-quote";
import { assetDecimalsUnknownCopy } from "../lib/qwakk-tx-copy";

/** QoreChain AMM params report lp_token_decimals = 6 on Diana and mainnet. */
const LP_DECIMALS = 6;
const REFRESH_MS = 15_000;

export type LiquidityPool = {
  id: string | number;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: string | number | null;
  token_b_decimals: string | number | null;
  reserve_a: string;
  reserve_b: string;
  lp_supply?: string | null;
};

/** The pool exactly as the chain's AMM store holds it right now. */
type LivePool = { reserveA: string; reserveB: string; lpSupply: string; status: string; tokenA: string; tokenB: string; lpBalance: string; enabled: boolean };

function safe<T>(compute: () => T, fallback: T) {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

async function readLivePool(poolId: string, address: string): Promise<LivePool | null> {
  try {
    const response = await fetch(`/api/native/pool?id=${encodeURIComponent(poolId)}&address=${encodeURIComponent(address)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as { pool?: { reserveA: string; reserveB: string; lpSupply: string; status: string; tokenA: string; tokenB: string } | null; lpBalance?: string | null; params?: { enabled?: boolean } };
    if (!data.pool) return null;
    return { ...data.pool, lpBalance: data.lpBalance ?? "0", enabled: data.params?.enabled !== false };
  } catch {
    return null;
  }
}

/**
 * Add or withdraw liquidity with minimums derived from the pool's live
 * reserves. Each part renders only while its switch is on, so a remove-only
 * deployment shows the withdraw form alone.
 */
export function LiquidityPanel({ pool, walletAddress, allowAdd = true, allowRemove = true }: { pool: LiquidityPool; walletAddress: string; allowAdd?: boolean; allowRemove?: boolean }) {
  const tx = useNativeTransaction();
  const balances = useWalletBalances(walletAddress);
  // Write paths wait for /api/features: until then the asset registry is the default (testnet) one.
  const networkReady = useFeatures().network !== null;
  const [chosenMode, setMode] = useState<"add" | "remove">(allowAdd ? "add" : "remove");
  // A switch can turn off while the page is open; never show a part that is off.
  const mode: "add" | "remove" = chosenMode === "add" && !allowAdd ? "remove" : chosenMode === "remove" && !allowRemove ? "add" : chosenMode;
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [lpInput, setLpInput] = useState("");
  const [live, setLive] = useState<LivePool | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  // Typed amounts use only curated or freshly read bank-metadata decimals. The
  // indexed value labels balances and previews but never converts a deposit,
  // so a pool side with unknown decimals keeps deposits on hold.
  const resolve = useAssets([pool.token_a, pool.token_b]);
  const assetA = resolve(pool.token_a, { symbol: pool.token_a_symbol, decimals: pool.token_a_decimals });
  const assetB = resolve(pool.token_b, { symbol: pool.token_b_symbol, decimals: pool.token_b_decimals });
  const symbolA = assetA.symbol;
  const symbolB = assetB.symbol;
  const decimalsUnknown = assetA.decimals === null ? assetA.symbol : assetB.decimals === null ? assetB.symbol : "";
  // Zero only while deposits are blocked by decimalsUnknown; never sent with a guess.
  const decimalsA = assetA.decimals ?? 0;
  const decimalsB = assetB.decimals ?? 0;
  const poolId = String(pool.id);

  const refresh = useCallback(async () => {
    const next = await readLivePool(poolId, walletAddress);
    if (next) setLive(next);
    return next;
  }, [poolId, walletAddress]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onConfirmed = () => void refresh();
    window.addEventListener("qwakk:tx-confirmed", onConfirmed);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("qwakk:tx-confirmed", onConfirmed); };
  }, [refresh]);

  // Live chain state drives every number. Until it loads, nothing can be submitted.
  const reserveA = live?.reserveA ?? pool.reserve_a;
  const reserveB = live?.reserveB ?? pool.reserve_b;
  const supply = live?.lpSupply ?? (/^\d+$/.test(pool.lp_supply ?? "") ? pool.lp_supply as string : "0");
  const lpBalance = live?.lpBalance ?? "0";
  const paused = live ? live.status !== "active" || !live.enabled : false;

  function changeAmountA(value: string) {
    setAmountA(value);
    setError("");
    const matched = safe(() => matchingDeposit(toBaseAmount(value, decimalsA), reserveA, reserveB), null);
    setAmountB(matched ? formatBaseAmount(matched, decimalsB, decimalsB) : "");
  }

  function changeAmountB(value: string) {
    setAmountB(value);
    setError("");
    const matched = safe(() => matchingDeposit(toBaseAmount(value, decimalsB), reserveB, reserveA), null);
    setAmountA(matched ? formatBaseAmount(matched, decimalsA, decimalsA) : "");
  }

  const baseA = decimalsUnknown ? "" : safe(() => toBaseAmount(amountA, decimalsA), "");
  const baseB = decimalsUnknown ? "" : safe(() => toBaseAmount(amountB, decimalsB), "");
  const expectedLp = baseA && baseB ? safe(() => expectedLpForDeposit(baseA, baseB, reserveA, reserveB, supply), null) : null;
  const share = expectedLp ? safe(() => poolShareBps(expectedLp, supply), null) : null;
  const baseLp = safe(() => toBaseAmount(lpInput, LP_DECIMALS), "");
  const withdrawal = baseLp ? safe(() => expectedWithdrawal(baseLp, reserveA, reserveB, supply), null) : null;
  const depositFits = balances && baseA && baseB ? coversSpend({ balances, spend: [{ denom: pool.token_a, amount: baseA }, { denom: pool.token_b, amount: baseB }] }) : null;
  const feeFits = balances ? coversSpend({ balances, spend: [] }) : null;

  function fillPercent(percent: number) {
    const amount = (BigInt(lpBalance) * BigInt(percent)) / BigInt(100);
    setLpInput(formatBaseAmount(amount.toString(), LP_DECIMALS, LP_DECIMALS));
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || tx.busy) return;
    setError("");
    if ((mode === "add" && !allowAdd) || (mode === "remove" && !allowRemove) || !networkReady) return;
    if (paused) return setError("This pool is paused right now, so liquidity changes are on hold.");
    // Withdrawals use LP shares and base-unit minimums, so only deposits need the decimals.
    if (mode === "add" && decimalsUnknown) return setError(assetDecimalsUnknownCopy(decimalsUnknown));
    if (mode === "add") {
      if (!baseA || !baseB) return setError("Enter both amounts.");
      if (depositFits === false) return setError("This wallet does not hold enough for both amounts plus the network fee.");
    } else {
      if (!baseLp) return setError("Enter the share to withdraw.");
      if (BigInt(baseLp) > BigInt(lpBalance)) return setError("This is more than your share of the pool.");
      if (feeFits === false) return setError("This wallet needs a little QOR for the network fee.");
    }

    // Read the pool again right before signing, so the minimums match the chain.
    setChecking(true);
    const fresh = await refresh();
    setChecking(false);
    if (!fresh) return setError("This pool's reserves could not be read. Try again shortly.");
    if (fresh.status !== "active" || !fresh.enabled) return setError("This pool is paused right now, so liquidity changes are on hold.");

    if (mode === "add") {
      // The keeper's handling of a deposit off the pool ratio is not public, so
      // never send one: if the ratio moved, refill the amounts for review.
      const matchedB = safe(() => matchingDeposit(baseA, fresh.reserveA, fresh.reserveB), null);
      if (!matchedB || !withinTolerance(baseB, matchedB, slippageBps)) {
        if (matchedB) setAmountB(formatBaseAmount(matchedB, decimalsB, decimalsB));
        return setError("The pool ratio moved. The amounts were updated to match it. Check them and submit again.");
      }
      // Within tolerance, still send B re-matched to the live ratio (not the
      // typed amount), so no excess is left for the pool to keep.
      if (matchedB === "0") return setError("This deposit is too small for the pool. Enter a larger amount.");
      if (balances && !coversSpend({ balances, spend: [{ denom: pool.token_a, amount: baseA }, { denom: pool.token_b, amount: matchedB }] })) {
        setAmountB(formatBaseAmount(matchedB, decimalsB, decimalsB));
        return setError("This wallet does not hold enough for both amounts plus the network fee.");
      }
      const freshLp = safe(() => expectedLpForDeposit(baseA, matchedB, fresh.reserveA, fresh.reserveB, fresh.lpSupply), null);
      if (!freshLp || freshLp === "0") return setError("This deposit is too small for the pool. Enter a larger amount.");
      const minLpOut = applySlippage(freshLp, slippageBps);
      if (minLpOut === "0") return setError("This deposit is too small for the pool. Enter a larger amount.");
      if (matchedB !== baseB) setAmountB(formatBaseAmount(matchedB, decimalsB, decimalsB));
      void tx.run({ kind: "add_liquidity", poolId, denomA: pool.token_a, amountA: baseA, denomB: pool.token_b, amountB: matchedB, minLpOut });
      return;
    }

    if (BigInt(baseLp) > BigInt(fresh.lpBalance)) return setError("This is more than your share of the pool.");
    const freshOut = safe(() => expectedWithdrawal(baseLp, fresh.reserveA, fresh.reserveB, fresh.lpSupply), null);
    if (!freshOut) return setError("This pool's reserves could not be read. Try again shortly.");
    if (withdrawal && (!withinTolerance(freshOut.amountA, withdrawal.amountA, slippageBps) || !withinTolerance(freshOut.amountB, withdrawal.amountB, slippageBps))) {
      return setError("The pool moved since these amounts were shown. Check the new amounts and submit again.");
    }
    const minAmountA = applySlippage(freshOut.amountA, slippageBps);
    const minAmountB = applySlippage(freshOut.amountB, slippageBps);
    if (minAmountA === "0" && minAmountB === "0") return setError("This withdrawal is too small. Enter a larger share.");
    void tx.run({ kind: "remove_liquidity", poolId, lpAmount: baseLp, minAmountA, minAmountB });
  }

  if (tx.state.phase !== "idle") return <div className="panel-body"><TxProgress state={tx.state} onDone={() => { tx.reset(); setAmountA(""); setAmountB(""); setLpInput(""); }} /></div>;

  const busy = checking || tx.busy;
  const ready = Boolean(live) && !paused && networkReady;

  return <form className="panel-body form-grid" onSubmit={submit}>
    {allowAdd && allowRemove && <div className="segmented" role="group" aria-label="Liquidity action">
      <button type="button" aria-pressed={mode === "add"} onClick={() => { setMode("add"); setError(""); }}>Add</button>
      <button type="button" aria-pressed={mode === "remove"} onClick={() => { setMode("remove"); setError(""); }}>Remove</button>
    </div>}
    {paused && <p className="form-error" role="alert">This pool is paused right now, so liquidity changes are on hold.</p>}
    {mode === "add" && decimalsUnknown && <p className="form-error" role="alert">{assetDecimalsUnknownCopy(decimalsUnknown)}</p>}
    {mode === "add" ? <>
      <label className="field"><span>{symbolA}</span><input inputMode="decimal" value={amountA} disabled={busy || Boolean(decimalsUnknown)} onChange={(event) => changeAmountA(event.target.value)} placeholder="0.0" />{balances && <small className="subtle">Balance {formatTokenAmount((balances.get(pool.token_a) ?? BigInt(0)).toString(), assetA.displayDecimals, symbolA)}</small>}</label>
      <label className="field"><span>{symbolB}</span><input inputMode="decimal" value={amountB} disabled={busy || Boolean(decimalsUnknown)} onChange={(event) => changeAmountB(event.target.value)} placeholder="0.0" /><small className="subtle">{balances ? `Balance ${formatTokenAmount((balances.get(pool.token_b) ?? BigInt(0)).toString(), assetB.displayDecimals, symbolB)}. ` : ""}Both amounts follow the pool&apos;s current ratio.</small></label>
      <p className="quote-meta-row"><span>Pool share you receive</span><b className="num">{expectedLp ? `${formatVisibleAmount(expectedLp, LP_DECIMALS, 6)}${share !== null ? ` (${(share / 100).toFixed(2)}% of the pool)` : ""}` : "Not available"}</b></p>
      {depositFits === false && <><p className="form-error">This wallet does not hold enough for both amounts plus the network fee.</p><FaucetHint /></>}
    </> : <>
      <label className="field"><span>Share to withdraw</span><input inputMode="decimal" value={lpInput} disabled={busy} onChange={(event) => { setLpInput(event.target.value); setError(""); }} placeholder="0.0" /><small className="subtle">You hold {formatVisibleAmount(lpBalance, LP_DECIMALS, 6)}</small></label>
      <div className="chip-row">{[25, 50, 75, 100].map((percent) => <button type="button" className="btn btn-ghost btn-sm" key={percent} disabled={lpBalance === "0" || busy} onClick={() => fillPercent(percent)}>{percent}%</button>)}</div>
      <p className="quote-meta-row"><span>You receive about</span><b className="num">{withdrawal ? `${formatTokenAmount(withdrawal.amountA, assetA.displayDecimals, symbolA)} + ${formatTokenAmount(withdrawal.amountB, assetB.displayDecimals, symbolB)}` : "Not available"}</b></p>
    </>}
    <label className="quote-meta-row"><span>Price protection</span><select value={slippageBps} disabled={busy} onChange={(event) => setSlippageBps(Number(event.target.value))}><option value={10}>0.10%</option><option value={50}>0.50%</option><option value={100}>1.00%</option></select></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    {mode === "remove" && feeFits === false && <FaucetHint lead="This wallet needs a little QOR for the network fee." />}
    <button type="submit" className="btn btn-primary" disabled={!ready || busy || (mode === "add" && Boolean(decimalsUnknown))}>{checking ? "Checking the pool…" : !live ? "Reading the pool…" : mode === "add" ? "Add liquidity" : "Withdraw"}</button>
  </form>;
}
