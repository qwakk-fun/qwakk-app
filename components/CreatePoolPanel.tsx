"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { FaucetHint } from "./FaucetHint";
import { useNetworkCopy } from "./NetworkContext";
import { useFeatures } from "./useFeatures";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { useAssets } from "./useAssets";
import { useWalletBalances } from "./useWalletBalances";
import { createPoolTokenOptions, displaySymbol, formatBaseAmount, toBaseAmount } from "../lib/qwakk-assets";
import { FAUCET_DAILY_UQOR } from "../lib/qwakk-faucet";
import { START_PRICE_WARN_PERCENT, formatQuotePrice, impliedPairPrice, priceDifferencePercent, type QuoteMarket } from "../lib/qwakk-market-view";
import { formatRatio } from "../lib/qwakk-amm-math";
import { coversSpend } from "../lib/qwakk-quote";
import { assetDecimalsUnknownCopy } from "../lib/qwakk-tx-copy";

type AmmInfo = { poolCreationFee: string | null; minLiquidity: string | null } | null;

/** Base units for a typed amount, or "" when the amount or the token's decimals are not usable. */
function safeBase(value: string, decimals: number | null) {
  try {
    return decimals === null ? "" : toBaseAmount(value, decimals);
  } catch {
    return "";
  }
}

/** What one claim of the testnet faucet means for the pool creation fee. */
function faucetDaysCopy(creationFee: bigint) {
  if (creationFee > FAUCET_DAILY_UQOR) return "That is more than one day of faucet QOR (100 QOR), so plan on several days of claims before you create a pool.";
  if (creationFee === FAUCET_DAILY_UQOR) return "One day of faucet QOR (100 QOR) covers the fee alone, so plan on at least two days of claims to also fund the QOR side and the network fee.";
  return "";
}

/**
 * Seeds a new native AMM pool from two tokens the connected wallet holds.
 * `markets` are the indexed pools, used to check the starting price against
 * the price other pools imply.
 */
export function CreatePoolPanel({ walletAddress, amm, markets = [], onBusyChange }: { walletAddress: string; amm: AmmInfo; markets?: readonly QuoteMarket[]; onBusyChange?: (busy: boolean) => void }) {
  const tx = useNativeTransaction();
  const { copy, isTestnet } = useNetworkCopy();
  // Write paths wait for /api/features: until then the asset registry is the default (testnet) one.
  const networkReady = useFeatures().network !== null;
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

  // Curated Diana tokens first, then anything else this wallet holds, with the chain's exact denoms.
  const options = useMemo(() => createPoolTokenOptions(balances), [balances]);
  const resolve = useAssets(options);
  const symbolOf = (denom: string) => resolve(denom).symbol;
  const decimalsFor = (denom: string) => resolve(denom).decimals;
  const balanceOf = (denom: string) => (balances?.get(denom) ?? BigInt(0)).toString();
  const creationFee = amm?.poolCreationFee && /^\d+$/.test(amm.poolCreationFee) ? BigInt(amm.poolCreationFee) : null;
  const minLiquidity = amm?.minLiquidity && /^\d+$/.test(amm.minLiquidity) ? BigInt(amm.minLiquidity) : null;

  const decimalsA = denomA ? decimalsFor(denomA) : null;
  const decimalsB = denomB ? decimalsFor(denomB) : null;
  const baseA = safeBase(amountA, decimalsA);
  const baseB = safeBase(amountB, decimalsB);
  const pairReady = Boolean(denomA && denomB && denomA !== denomB && baseA && baseB && decimalsA !== null && decimalsB !== null);
  const priceAB = pairReady ? formatRatio(baseB, decimalsB as number, baseA, decimalsA as number, 6) : null;
  const priceBA = pairReady ? formatRatio(baseA, decimalsA as number, baseB, decimalsB as number, 6) : null;
  // The first deposit fixes the pool price, so compare it with what existing pools imply (via QOR or a dollar token).
  const enteredPrice = pairReady ? Number(formatRatio(baseB, decimalsB as number, baseA, decimalsA as number, 18)) : null;
  const implied = pairReady ? impliedPairPrice(markets, denomA, denomB) : null;
  const difference = enteredPrice !== null && implied ? priceDifferencePercent(enteredPrice, implied.price) : null;
  const priceOff = difference !== null && Math.abs(difference) > START_PRICE_WARN_PERCENT;

  function minLiquidityText(denom: string, decimals: number) {
    if (minLiquidity === null) return "";
    return `${formatBaseAmount(minLiquidity.toString(), decimals, decimals)} ${symbolOf(denom)}`;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (checking || tx.busy || !networkReady) return;
    setError("");
    setExistingPoolId("");
    if (!denomA || !denomB || denomA === denomB) return setError("Choose two different tokens.");
    // Never guess decimals: a wrong guess would deposit a different amount than the one typed.
    if (decimalsA === null) return setError(assetDecimalsUnknownCopy(symbolOf(denomA)));
    if (decimalsB === null) return setError(assetDecimalsUnknownCopy(symbolOf(denomB)));
    let depositA: string;
    let depositB: string;
    try {
      depositA = toBaseAmount(amountA, decimalsA);
      depositB = toBaseAmount(amountB, decimalsB);
    } catch (reason) {
      return setError(reason instanceof Error ? reason.message : "Enter valid amounts.");
    }
    const amp = Number(amplification);
    if (poolType === "stable_swap" && (!Number.isInteger(amp) || amp < 1 || amp > 5_000)) return setError("Amplification must be a whole number from 1 to 5000.");
    if (creationFee === null || minLiquidity === null) return setError(copy("QoreChain Diana's pool settings could not be read. Try again shortly."));
    // Checked on the testnet: each deposit on its own must reach min_liquidity.
    if (BigInt(depositA) < minLiquidity) return setError(`Deposit at least ${minLiquidityText(denomA, decimalsA)}.`);
    if (BigInt(depositB) < minLiquidity) return setError(`Deposit at least ${minLiquidityText(denomB, decimalsB)}.`);
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
      return setError(copy("QoreChain Diana could not be checked for an existing pool. Try again shortly."));
    } finally {
      setChecking(false);
    }

    void tx.run({ kind: "create_pool", poolType, denomA, amountA: depositA, denomB, amountB: depositB, amplificationCoefficient: poolType === "stable_swap" ? amp : undefined });
  }

  // The dialog around this form must not close while a check or a QoreX approval is running.
  const busy = checking || tx.busy;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  if (tx.state.phase !== "idle") {
    return <section className="panel form-panel" aria-label="Pool creation"><TxProgress state={tx.state} onDone={tx.reset} /></section>;
  }

  return <form className="panel form-panel" onSubmit={submit} aria-labelledby="create-pool-title">
    <div className="panel-head"><span className="panel-title" id="create-pool-title">Choose two tokens</span></div>
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
      {([["A", denomA, setDenomA, amountA, setAmountA, decimalsA], ["B", denomB, setDenomB, amountB, setAmountB, decimalsB]] as const).map(([side, denom, setDenom, value, setValue, decimals]) => <div className="field-pair" key={side}>
        <label className="field">
          <span>Token {side}</span>
          <select value={denom} disabled={busy} onChange={(event) => { setDenom(event.target.value); setError(""); setExistingPoolId(""); }}>
            <option value="">Select a token</option>
            {options.map((option) => <option key={option} value={option}>{symbolOf(option)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount{denom ? ` (${symbolOf(denom)})` : ""}</span>
          <input inputMode="decimal" value={value} disabled={busy || (Boolean(denom) && decimals === null)} onChange={(event) => { setValue(event.target.value); setError(""); }} placeholder="0.0" />
          {denom && (decimals === null
            ? <small className="subtle">{assetDecimalsUnknownCopy(symbolOf(denom))}</small>
            : balances && <small className="subtle">Balance {formatBaseAmount(balanceOf(denom), decimals, 6)} {symbolOf(denom)}</small>)}
        </label>
      </div>)}
      {priceAB && priceBA && <div className="quote-meta-row start-price"><span>Starting price</span><span className="start-price-values num"><b>1 {symbolOf(denomA)} = {priceAB} {symbolOf(denomB)}</b><small>1 {symbolOf(denomB)} = {priceBA} {symbolOf(denomA)}</small></span></div>}
      {implied && difference !== null && (priceOff
        ? <div className="quote-alert" role="note"><p className="quote-alert-text"><AlertTriangle size={14} aria-hidden="true" /><span>This starting price is {formatQuotePrice(Math.abs(difference))}% {difference > 0 ? "above" : "below"} what other pools imply: about 1 {symbolOf(denomA)} = {formatQuotePrice(implied.price)} {symbolOf(denomB)}{implied.via ? ` (through ${displaySymbol(implied.via)} pools)` : ""}. The first deposit sets the price, and traders can buy from your pool at that price right away, so a price that is off can cost you part of your deposit.</span></p></div>
        : <p className="subtle form-note">In line with other pools: about 1 {symbolOf(denomA)} = {formatQuotePrice(implied.price)} {symbolOf(denomB)}{implied.via ? ` through ${displaySymbol(implied.via)} pools` : ""}.</p>)}
      {error && <p className="form-error" role="alert">{error}{existingPoolId && <> <Link href={`/pools/${existingPoolId}`}>Open pool #{existingPoolId}</Link></>}</p>}
      <p className="subtle form-note">The first deposit sets the starting price.{minLiquidity !== null ? " Each deposit must reach the pool minimum." : ""}</p>
      {creationFee !== null && <div className="cost-note">
        <b>Cost to create: {formatBaseAmount(creationFee.toString(), 6, 2)} QOR pool creation fee + both deposits + the network fee</b>
        {isTestnet && faucetDaysCopy(creationFee) && <p>{faucetDaysCopy(creationFee)}</p>}
        <FaucetHint lead="Need more?" />
      </div>}
      <button type="submit" className="btn btn-primary" disabled={busy || !networkReady}>{checking ? copy("Checking QoreChain Diana…") : "Create pool"}</button>
    </div>
  </form>;
}
