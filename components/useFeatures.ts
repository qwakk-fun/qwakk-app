"use client";

import { useEffect, useState } from "react";
import type { PublicQwakkNetwork } from "../lib/qwakk-network";
import { setAssetNetwork } from "../lib/qwakk-assets";

export type FeatureActions = { swap: boolean; add_liquidity: boolean; remove_liquidity: boolean; create_pool: boolean; rewards_claim: boolean };
export type Features = {
  /** True when at least one wallet action is on. */
  nativeActions: boolean;
  /** Each wallet action's own switch. Render an action only when its switch is on. */
  actions: FeatureActions;
  points: boolean;
  /**
   * Liquidity rewards render only when both the program (QWAKK_REWARDS_ENABLED)
   * and claims (`rewards_claim` with a configured contract) are on.
   */
  rewards: boolean;
  /** Null until `/api/features` answers: the browser never guesses the network. */
  network: PublicQwakkNetwork | null;
};

const ACTIONS_OFF: FeatureActions = { swap: false, add_liquidity: false, remove_liquidity: false, create_pool: false, rewards_claim: false };
export const FEATURES_OFF: Features = { nativeActions: false, actions: ACTIONS_OFF, points: false, rewards: false, network: null };

/** Switches can change in CapRover at runtime, so a loaded answer is reused for one minute only. */
const FEATURES_TTL_MS = 60_000;
let cached: { at: number; promise: Promise<Features | null> } | null = null;

function parseNetwork(value: unknown): PublicQwakkNetwork | null {
  const network = value as Partial<PublicQwakkNetwork> | null;
  if (!network || (network.id !== "testnet" && network.id !== "mainnet")) return null;
  if (typeof network.label !== "string" || !network.label || typeof network.chainId !== "string" || !/^[a-z0-9-]{3,64}$/.test(network.chainId)) return null;
  return { id: network.id, label: network.label, chainId: network.chainId };
}

function parseFeatures(data: unknown): Features {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const raw = (record.actions && typeof record.actions === "object" ? record.actions : {}) as Record<string, unknown>;
  const actions: FeatureActions = {
    swap: raw.swap === true,
    add_liquidity: raw.add_liquidity === true,
    remove_liquidity: raw.remove_liquidity === true,
    create_pool: raw.create_pool === true,
    rewards_claim: raw.rewards_claim === true,
  };
  return {
    nativeActions: Object.values(actions).some(Boolean),
    actions,
    points: record.points === true,
    rewards: record.rewards === true && actions.rewards_claim,
    network: parseNetwork(record.network),
  };
}

/**
 * Reads `/api/features` once per minute for the whole page. Resolves null
 * when it cannot be read, so callers fail closed. Also points the asset
 * registry at the deployment's network.
 */
export function loadFeatures(): Promise<Features | null> {
  const now = Date.now();
  if (cached && now - cached.at < FEATURES_TTL_MS) return cached.promise;
  const promise = fetch("/api/features", { cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<unknown> : null)
    .then((data) => {
      if (data === null) return null;
      const features = parseFeatures(data);
      if (features.network) setAssetNetwork(features.network.id);
      return features;
    })
    .catch(() => null);
  cached = { at: now, promise };
  // A failed read is not cached, so the next caller asks again.
  void promise.then((features) => { if (features === null && cached?.promise === promise) cached = null; });
  return promise;
}

/** Wallet actions and the points pages render only after the server confirms they are switched on. */
export function useFeatures() {
  const [features, setFeatures] = useState<Features>(FEATURES_OFF);
  useEffect(() => {
    let active = true;
    void loadFeatures().then((data) => { if (active && data) setFeatures(data); });
    return () => { active = false; };
  }, []);
  return features;
}
