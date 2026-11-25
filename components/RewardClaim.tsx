"use client";

import { useEffect, useState } from "react";
import { TxProgress } from "./TxProgress";
import { useNativeTransaction } from "./useNativeTransaction";
import { rememberClaimTx } from "./useRewards";
import type { QwakkRewardClaim } from "../lib/qwakk-rewards";
import { REWARDS_REVIEW } from "../lib/qwakk-rewards-copy";
import { claimActionFor } from "../lib/qwakk-rewards-view";

/**
 * One claim at a time for a surface. While a claim is in QoreX or waiting
 * for its block, `pinned` keeps that claim on screen, so the next open week
 * does not replace it when the claimed state reloads.
 */
export function useRewardClaimFlow(address: string, contract: string | null) {
  const tx = useNativeTransaction();
  const [active, setActive] = useState<QwakkRewardClaim | null>(null);
  const [reviewing, setReviewing] = useState<QwakkRewardClaim | null>(null);

  // A confirmed claim's hash, keyed by the contract the claimed answers come
  // from (the server's configured one), so the claimed week links to its transaction.
  useEffect(() => {
    if (tx.state.phase === "success" && tx.state.txhash && active && contract) rememberClaimTx(contract, address, active.stageId, tx.state.txhash);
  }, [tx.state.phase, tx.state.txhash, active, address, contract]);

  return {
    tx,
    reviewing,
    pinned: tx.state.phase !== "idle" ? active : null,
    review: (claim: QwakkRewardClaim) => { tx.reset(); setReviewing(claim); },
    cancel: () => setReviewing(null),
    send: (claim: QwakkRewardClaim) => {
      if (tx.busy) return;
      setReviewing(null);
      setActive(claim);
      void tx.run(claimActionFor(claim));
    },
    done: () => { tx.reset(); setActive(null); },
  };
}

export type RewardClaimFlow = ReturnType<typeof useRewardClaimFlow>;

/**
 * The claim's one primary button, then its review, then the shared
 * transaction progress (QoreX approval, block, explorer link, mapped errors).
 */
export function RewardClaimAction({ flow, claim, amount, label }: { flow: RewardClaimFlow; claim: QwakkRewardClaim; amount: string; label: string }) {
  if (flow.pinned && flow.pinned.stageId === claim.stageId && flow.pinned.programId === claim.programId) {
    return <TxProgress state={flow.tx.state} onDone={flow.done} />;
  }
  if (flow.reviewing && flow.reviewing.stageId === claim.stageId && flow.reviewing.programId === claim.programId) {
    return <div className="review">
      <p className="review-line">{REWARDS_REVIEW.lead} <b>{amount}</b> {REWARDS_REVIEW.tail(claim.epoch)}</p>
      <p className="subtle rewards-review-fee">{REWARDS_REVIEW.fee}</p>
      <div className="review-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={flow.cancel}>{REWARDS_REVIEW.cancel}</button>
        <button type="button" className="btn btn-primary btn-lg" disabled={flow.tx.busy} onClick={() => flow.send(claim)}>{REWARDS_REVIEW.confirm}</button>
      </div>
    </div>;
  }
  return <button type="button" className="btn btn-primary btn-block btn-lg" disabled={flow.tx.busy} onClick={() => flow.review(claim)}>{label}</button>;
}
