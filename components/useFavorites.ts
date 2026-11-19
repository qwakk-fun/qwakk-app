"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FAVORITES_EVENT, FAVORITES_KEY, favoritesFor, parseFavorites, readFavoritesRaw, saveFavoriteToggle } from "../lib/qwakk-favorites";
import { loadFeatures } from "./useFeatures";

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  // Other tabs fire `storage`; this tab announces its own writes.
  const onStorage = (event: StorageEvent) => { if (event.key === FAVORITES_KEY || event.key === null) onChange(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(FAVORITES_EVENT, onChange);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(FAVORITES_EVENT, onChange); };
}

/** The raw string is the snapshot, so React compares it cheaply and parses only when it changes. */
const readSnapshot = () => readFavoritesRaw(browserStorage());
const readServerSnapshot = () => null;

/** Waits between attempts when `/api/features` cannot be read; the last one repeats. */
const NETWORK_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * The deployment's network id. Unlike `useFeatures`, a failed read is retried
 * (backing off), and `failed` says so meanwhile, so stars never sit disabled
 * without a word.
 */
function useNetworkId() {
  const [result, setResult] = useState<{ network: string | null; failed: boolean }>({ network: null, failed: false });
  useEffect(() => {
    let active = true;
    let timer = 0;
    let attempt = 0;
    const read = () => {
      void loadFeatures().then((features) => {
        if (!active) return;
        const network = features?.network?.id ?? null;
        if (network) { setResult({ network, failed: false }); return; }
        setResult({ network: null, failed: true });
        timer = window.setTimeout(read, NETWORK_RETRY_MS[Math.min(attempt, NETWORK_RETRY_MS.length - 1)]);
        attempt += 1;
      });
    };
    read();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  return result;
}

export type Favorites = {
  /** Newest first. Empty until the network is known. */
  ids: readonly string[];
  has: (poolId: string | number) => boolean;
  toggle: (poolId: string | number) => void;
  /** False until `/api/features` names the network, since pool ids belong to one network. */
  ready: boolean;
  /** True while the network could not be read (it keeps retrying). */
  failed: boolean;
};

/** Favorite pools for the deployment's network, shared by every star on the page and across tabs. */
export function useFavorites(): Favorites {
  const { network, failed } = useNetworkId();
  const raw = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);
  const ids = useMemo(() => favoritesFor(parseFavorites(raw), network), [raw, network]);
  const has = useCallback((poolId: string | number) => ids.includes(String(poolId)), [ids]);
  const toggle = useCallback((poolId: string | number) => {
    if (!network) return;
    if (saveFavoriteToggle(browserStorage(), network, poolId)) window.dispatchEvent(new Event(FAVORITES_EVENT));
  }, [network]);
  return { ids, has, toggle, ready: network !== null, failed: network === null && failed };
}
