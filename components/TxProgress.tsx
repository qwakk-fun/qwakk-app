"use client";

import { CheckCircle2, CircleAlert, ExternalLink, Info, Loader2 } from "lucide-react";
import { BRAND } from "../lib/brand";
import { assetForDenom, displaySymbol, formatBaseAmount, formatVisibleAmount } from "../lib/qwakk-assets";
import { explorerTxUrl } from "../lib/qwakk-network";
import { interfaceFeeTransferCopy } from "../lib/qwakk-tx-copy";
import { useNetworkCopy } from "./NetworkContext";
import type { TxState } from "./useNativeTransaction";

/** An amount with its symbol, or null when the token's decimals are not known (never shown at a guessed scale). */
function amountText(amount: string, denom: string) {
  const decimals = assetForDenom(denom)?.decimals;
  return decimals === undefined ? null : `${formatVisibleAmount(amount, decimals, 6)} ${displaySymbol(denom)}`;
}

const STEPS = [
  { phase: "preparing", label: "Checking with {network}" },
  { phase: "signing", label: "Approve in QoreX" },
  { phase: "confirming", label: "Waiting for a block" },
] as const;

/** Shows where a native transaction is, then its result with an explorer link. */
export function TxProgress({ state, onDone }: { state: TxState; onDone: () => void }) {
  const networkLabel = useNetworkCopy().label;
  if (state.phase === "idle") return null;
  const finished = state.phase === "success" || state.phase === "failed";
  const current = STEPS.findIndex((step) => step.phase === state.phase);

  // A wallet-side stop (locked, declined, request already open) sent nothing, so it reads as a notice, not a red failure.
  const quiet = state.phase === "failed" && state.quiet;

  return <div className={`tx-progress ${state.phase}${quiet ? " is-quiet" : ""}`} role="status" aria-live="polite">
    {finished ? <p className="tx-result">
      {state.phase === "success" ? <CheckCircle2 size={18} className="tx-ok" aria-hidden="true" /> : quiet ? <Info size={18} /> : <CircleAlert size={18} className="down" />}
      <span>{state.message}</span>
    </p> : <ol className="tx-steps">
      {STEPS.map((step, index) => <li key={step.phase} className={index < current ? "is-done" : index === current ? "is-current" : ""}>
        {index === current ? <Loader2 size={14} className="spin" /> : <span className="tx-step-dot" />}
        {step.label.replace("{network}", networkLabel)}
      </li>)}
    </ol>}
    {state.phase === "signing" && <p className="subtle">After you approve, QoreX signs and sends the transaction, then waits for a block.</p>}
    {state.phase === "signing" && state.keySetup && <p className="subtle">First time on {networkLabel}: QoreX also registers your quantum-safe key in a separate transaction with its own network fee.</p>}
    {state.phase === "signing" && !state.exactOut && state.simulated?.swap && amountText(state.simulated.swap.amountOut, state.simulated.swap.denomOut) && <p className="subtle">Simulated on {networkLabel} just now: {amountText(state.simulated.swap.amountOut, state.simulated.swap.denomOut)} out. Your minimum still applies when the swap lands.</p>}
    {state.phase === "signing" && state.exactOut && state.simulated?.swap && amountText(state.simulated.swap.amountIn, state.simulated.swap.denomIn) && <p className="subtle">Simulated on {networkLabel} just now: {amountText(state.simulated.swap.amountIn, state.simulated.swap.denomIn)} into the pool. Your maximum still applies when the swap lands.</p>}
    {state.phase === "signing" && state.interfaceFee && <p className="subtle">{interfaceFeeTransferCopy(amountText(state.interfaceFee.amount, state.interfaceFee.denom) ?? `${state.interfaceFee.amount} ${displaySymbol(state.interfaceFee.denom)} base units`, BRAND.name)}</p>}
    {state.phase === "signing" && state.fee && <p className="subtle">Estimated network fee {formatBaseAmount(state.fee, 6, 6)} QOR. QoreX shows the final fee.</p>}
    <div className="tx-actions">
      {state.txhash && <a className="btn btn-ghost btn-sm" href={explorerTxUrl(state.txhash)} target="_blank" rel="noreferrer">View in explorer <ExternalLink size={13} /></a>}
      {finished && <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>{state.phase === "success" ? "Done" : "Close"}</button>}
    </div>
  </div>;
}
