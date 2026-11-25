"use client";

import { useCallback, useEffect, useState } from "react";
import type { QwakkRewardProgramsResponse, QwakkRewardsAddressResponse } from "../lib/qwakk-rewards";

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
  /** The contract's `is_claimed` per stage id. A stage missing here is unknown. */
  claimed: Record<string, boolean>;
  reload: () => void;
};

async function readClaimed(address: string, stages: number[], signal: AbortSignal): Promise<Record<string, boolean>> {
  if (!stages.length) return {};
  try {
    const response = await fetch(`/api/rewards/${address}/claimed?stages=${stages.join(",")}`, { cache: "no-store", signal });
    if (!response.ok) return {};
    const data = await response.json() as { claimed?: unknown };
    const claimed: Record<string, boolean> = {};
    if (data.claimed && typeof data.claimed === "object") {
      for (const [stage, value] of Object.entries(data.claimed as Record<string, unknown>)) if (typeof value === "boolean") claimed[stage] = value;
    }
    return claimed;
  } catch {
    return {};
  }
}

/**
 * One wallet's rewards: finalized weeks with their proofs, the running week's
 * estimate, and which stages the contract already paid out. Reloads on an
 * interval and right after a confirmed transaction.
 */
export function useAddressRewards(address: string, enabled: boolean): AddressRewardsState {
  // Kept with the address it belongs to, so a new wallet never shows the previous wallet's rewards.
  const [state, setState] = useState<{ address: string; status: "ready" | "unavailable"; data: QwakkRewardsAddressResponse | null; claimed: Record<string, boolean> } | null>(null);
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
          setState((current) => keep(current) ?? { address, status: "unavailable", data: null, claimed: {} });
          return;
        }
        const stages = [...new Set(data.claims.filter((claim) => claim.status === "registered" && Number.isSafeInteger(claim.stageId)).map((claim) => claim.stageId))];
        const claimed = await readClaimed(address, stages, controller.signal);
        if (controller.signal.aborted) return;
        // A claim is final: keep a "claimed" seen earlier if this read missed it.
        setState((current) => {
          const earlier = keep(current)?.claimed ?? {};
          return { address, status: "ready", data, claimed: { ...Object.fromEntries(Object.entries(earlier).filter(([, value]) => value)), ...claimed } };
        });
      } catch {
        if (!controller.signal.aborted) setState((current) => keep(current) ?? { address, status: "unavailable", data: null, claimed: {} });
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

  if (!enabled || !address) return { status: "idle", data: null, claimed: {}, reload };
  if (!state || state.address !== address) return { status: "loading", data: null, claimed: {}, reload };
  return { status: state.status, data: state.data, claimed: state.claimed, reload };
}

const CLAIM_TX_KEY = "qwakk-rewards-claim-tx";

/**
 * Claim hashes this browser saw, keyed by wallet and stage, so a claimed week
 * can link to its transaction. A convenience only: the contract is the record.
 */
export function readClaimTx(address: string, stageId: number): string | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CLAIM_TX_KEY) ?? "{}") as Record<string, unknown>;
    const hash = stored[`${address}|${stageId}`];
    return typeof hash === "string" && /^[0-9A-F]{64}$/i.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

export function rememberClaimTx(address: string, stageId: number, hash: string) {
  if (!/^[0-9A-F]{64}$/i.test(hash)) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(CLAIM_TX_KEY) ?? "{}") as Record<string, string>;
    stored[`${address}|${stageId}`] = hash;
    // Bounded: keep the most recent 200 claims.
    const entries = Object.entries(stored).slice(-200);
    window.localStorage.setItem(CLAIM_TX_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage can be blocked; the claim itself is on chain either way.
  }
}
