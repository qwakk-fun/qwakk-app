"use client";

import { CheckCircle2, CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { formatBaseAmount } from "../lib/qora-assets";
import type { TxState } from "./useNativeTransaction";

const STEPS = [
  { phase: "preparing", label: "Checking with QoreChain Diana" },
  { phase: "signing", label: "Approve in QoreX" },
  { phase: "submitting", label: "Submitting" },
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
    {state.fee && <p className="subtle">Network fee {formatBaseAmount(state.fee, 6, 6)} QOR</p>}
    <div className="tx-actions">
      {state.txhash && <a className="btn btn-ghost btn-sm" href={`https://explore.qore.network/tx/${state.txhash}`} target="_blank" rel="noreferrer">View in explorer <ExternalLink size={13} /></a>}
      {finished && <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>{state.phase === "success" ? "Done" : "Close"}</button>}
    </div>
  </div>;
}
