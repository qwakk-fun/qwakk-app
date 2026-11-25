"use client";

import { useCallback, useEffect, useState } from "react";
import type { QwakkRewardProgramsResponse, QwakkRewardsAddressResponse } from "../lib/qwakk-rewards";
import { chunkList, claimKeyFor, claimStagesToCheck, mergeClaimed } from "../lib/qwakk-rewards-view";

/** Shares are recomputed hourly by the indexer; a minute keeps the page close without load. */
export const REWARDS_REFRESH_MS = 60_000;

export type RewardProgramsState = { status: "loading" | "ready" | "unavailable"; data: QwakkRewardProgramsResponse | null };

/** Rewards programs with their running week. Reads nothing while `enabled` is false. */
export function useRewardPrograms(enabled: boolean): RewardProgramsState {
  const [state, setState] = useState<RewardProgramsState>({ status: "loading", data: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/rewards", { cache: "no-store", signal: controller.signal });
        const data = response.ok ? await response.json() as QwakkRewardProgramsResponse | null : null;
        if (controller.signal.aborted) return;
        if (data && Array.isArray(data.programs) && data.rules) setState({ status: "ready", data });
        // A failed background refresh keeps what is already on screen.
        else setState((current) => current.data ? current : { status: "unavailable", data: null });
      } catch {
        if (!controller.signal.aborted) setState((current) => current.data ? current : { status: "unavailable", data: null });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), REWARDS_REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [enabled]);
  return state;
}

export type AddressRewardsState = {
  status: "idle" | "loading" | "ready" | "unavailable";
  data: QwakkRewardsAddressResponse | null;
  /** The rewards contract the claimed answers came from, or null while unknown. */
  contract: string | null;
  /**
   * Whether this wallet claimed a stage: true when the contract said so or this
   * browser saw the claim confirm (a claim is final, so either wins), false
   * only on the contract's word, undefined while unknown.
   */
  isClaimed: (stageId: number) => boolean | undefined;
  /** The claim transaction this browser saw confirm for a stage, if any. */
  claimTx: (stageId: number) => string | null;
  reload: () => void;
};

type ClaimedRead = { contract: string | null; claimed: Record<string, boolean> };

/** Asks the contract about the given stages, 24 per request, one request at a time. Answers are keyed by contract and stage. */
async function readClaimed(address: string, stages: number[], signal: AbortSignal): Promise<ClaimedRead> {
  const result: ClaimedRead = { contract: null, claimed: {} };
  for (const chunk of chunkList(stages)) {
    try {
      const response = await fetch(`/api/rewards/${address}/claimed?stages=${chunk.join(",")}`, { cache: "no-store", signal });
      if (!response.ok) continue;
      const data = await response.json() as { contract?: unknown; claimed?: unknown };
      if (typeof data.contract !== "string" || !/^qor1[0-9a-z]{38,90}$/.test(data.contract)) continue;
      result.contract = data.contract;
      if (data.claimed && typeof data.claimed === "object") {
        for (const [stage, value] of Object.entries(data.claimed as Record<string, unknown>)) {
          if (typeof value === "boolean" && /^\d+$/.test(stage)) result.claimed[claimKeyFor(data.contract, Number(stage))] = value;
        }
      }
    } catch {
      if (signal.aborted) break;
    }
  }
  return result;
}

/**
 * One wallet's rewards: finalized weeks with their proofs, the running week's
 * estimate, and which open stages the contract already paid out. Reloads on
 * an interval and right after a confirmed transaction.
 */
export function useAddressRewards(address: string, enabled: boolean): AddressRewardsState {
  // Kept with the address it belongs to, so a new wallet never shows the previous wallet's rewards.
  const [state, setState] = useState<{ address: string; status: "ready" | "unavailable"; data: QwakkRewardsAddressResponse | null; contract: string | null; claimed: Record<string, boolean> } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !address) return;
    const controller = new AbortController();
    const keep = (current: typeof state) => current?.address === address && current.data ? current : null;
    async function load() {
      try {
        const response = await fetch(`/api/rewards/${encodeURIComponent(address)}`, { cache: "no-store", signal: controller.signal });
        const data = response.ok ? await response.json() as QwakkRewardsAddressResponse | null : null;
        if (controller.signal.aborted) return;
        if (!data || !Array.isArray(data.claims) || !Array.isArray(data.current)) {
          // A failed background refresh keeps what is already on screen.
          setState((current) => keep(current) ?? { address, status: "unavailable", data: null, contract: null, claimed: {} });
          return;
        }
        const read = await readClaimed(address, claimStagesToCheck(data.claims, Date.now()), controller.signal);
        if (controller.signal.aborted) return;
        setState((current) => {
          const earlier = keep(current);
          // A claim is final: a "claimed" seen earlier is never undone by a later read.
          return { address, status: "ready", data, contract: read.contract ?? earlier?.contract ?? null, claimed: mergeClaimed(earlier?.claimed ?? {}, read.claimed) };
        });
      } catch {
        if (!controller.signal.aborted) setState((current) => keep(current) ?? { address, status: "unavailable", data: null, contract: null, claimed: {} });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), REWARDS_REFRESH_MS);
    // The contract's state changes in the same block; the indexer's estimate follows a little later.
    let later = 0;
    const onConfirmed = () => { void load(); window.clearTimeout(later); later = window.setTimeout(() => void load(), 8_000); };
    window.addEventListener("qwakk:tx-confirmed", onConfirmed);
    return () => { controller.abort(); window.clearInterval(timer); window.clearTimeout(later); window.removeEventListener("qwakk:tx-confirmed", onConfirmed); };
  }, [address, enabled, reloadKey]);

  const current = enabled && address && state?.address === address ? state : null;
  const contract = current?.contract ?? null;
  const claimTx = (stageId: number) => contract ? readClaimTx(contract, address, stageId) : null;
  const isClaimed = (stageId: number) => {
    if (!contract) return undefined;
    // A confirmed claim this browser saw beats any stale "not claimed".
    if (readClaimTx(contract, address, stageId)) return true;
    return current?.claimed[claimKeyFor(contract, stageId)];
  };
  if (!enabled || !address) return { status: "idle", data: null, contract: null, isClaimed, claimTx, reload };
  if (!current) return { status: "loading", data: null, contract: null, isClaimed, claimTx, reload };
  return { status: current.status, data: current.data, contract, isClaimed, claimTx, reload };
}

const CLAIM_TX_KEY = "qwakk-rewards-claim-tx";
const HASH = /^[0-9A-F]{64}$/i;

/**
 * Claim hashes this browser saw confirm, keyed by contract, wallet and stage,
 * so a claimed week can link to its transaction. A convenience only: the
 * contract is the record.
 */
export function readClaimTx(contract: string, address: string, stageId: number): string | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CLAIM_TX_KEY) ?? "{}") as Record<string, unknown>;
    const hash = stored[`${contract}|${address}|${stageId}`];
    return typeof hash === "string" && HASH.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function rememberClaimTx(contract: string, address: string, stageId: number, hash: string) {
  if (!HASH.test(hash)) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(CLAIM_TX_KEY) ?? "{}") as Record<string, string>;
    stored[`${contract}|${address}|${stageId}`] = hash;
    // Bounded: keep the most recent 200 claims.
    const entries = Object.entries(stored).slice(-200);
    window.localStorage.setItem(CLAIM_TX_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be blocked; the claim itself is on chain either way.
  }
}
