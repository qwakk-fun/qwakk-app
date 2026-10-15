"use client";

import { CheckCircle2, CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { BRAND } from "../lib/brand";
import { assetForDenom, displaySymbol, formatBaseAmount } from "../lib/qwakk-assets";
import type { TxState } from "./useNativeTransaction";

const STEPS = [
  { phase: "preparing", label: "Checking with QoreChain Diana" },
  { phase: "signing", label: "Approve in QoreX" },
  { phase: "confirming", label: "Waiting for a block" },
] as const;

/** Shows where a native transaction is, then its result with an explorer link. */
export function TxProgress({ state, onDone }: { state: TxState; onDone: () => void }) {
  if (state.phase === "idle") return null;
  const finished = state.phase === "success" || state.phase === "failed";
  const current = STEPS.findIndex((step) => step.phase === state.phase);

  return <div className={`tx-progress ${state.phase}`} role="status" aria-live="polite">
    {finished ? <p className="tx-result">
      {state.phase === "success" ? <CheckCircle2 size={18} className="up" /> : <CircleAlert size={18} className="down" />}
      <span>{state.message}</span>
    </p> : <ol className="tx-steps">
      {STEPS.map((step, index) => <li key={step.phase} className={index < current ? "is-done" : index === current ? "is-current" : ""}>
        {index === current ? <Loader2 size={14} className="spin" /> : <span className="tx-step-dot" />}
        {step.label}
      </li>)}
    </ol>}
    {state.phase === "signing" && <p className="subtle">After you approve, QoreX signs and sends the transaction, then waits for a block.</p>}
    {state.phase === "signing" && state.keySetup && <p className="subtle">First time on QoreChain Diana: QoreX also registers your quantum-safe key in a separate transaction with its own network fee.</p>}
    {state.phase === "signing" && state.simulated?.swap && <p className="subtle">Simulated on QoreChain Diana just now: {formatBaseAmount(state.simulated.swap.amountOut, assetForDenom(state.simulated.swap.denomOut)?.decimals ?? 0, 6)} {displaySymbol(state.simulated.swap.denomOut)} out. Your minimum still applies when the swap lands.</p>}
    {state.phase === "signing" && state.interfaceFee && <p className="subtle">This transaction includes the {formatBaseAmount(state.interfaceFee.amount, assetForDenom(state.interfaceFee.denom)?.decimals ?? 0, 6)} {displaySymbol(state.interfaceFee.denom)} interface fee. In QoreX it appears as a MsgSend to the {BRAND.name} treasury.</p>}
    {state.phase === "signing" && state.fee && <p className="subtle">Estimated network fee {formatBaseAmount(state.fee, 6, 6)} QOR. QoreX shows the final fee.</p>}
    <div className="tx-actions">
      {state.txhash && <a className="btn btn-ghost btn-sm" href={`https://explore.qore.network/tx/${state.txhash}`} target="_blank" rel="noreferrer">View in explorer <ExternalLink size={13} /></a>}
      {finished && <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>{state.phase === "success" ? "Done" : "Close"}</button>}
    </div>
  </div>;
}
