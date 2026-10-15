"use client";

import { useEffect, useState } from "react";

/**
 * The connected wallet's bank balances in base units, read through
 * `/api/account`. Null until the first read succeeds, so a form never treats
 * an unknown balance as zero. Re-read after every confirmed transaction.
 */
export function useWalletBalances(address: string) {
  const [state, setState] = useState<{ address: string; balances: Map<string, bigint> } | null>(null);

  useEffect(() => {
    if (!address) return;
    let active = true;
    const load = () => {
      fetch(`/api/account?address=${encodeURIComponent(address)}`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ balances?: Array<{ denom?: string; amount?: string }> }> : null)
        .then((data) => {
          if (!active || !data) return;
          const balances = new Map<string, bigint>();
          for (const coin of data.balances ?? []) {
            if (typeof coin.denom === "string" && /^\d+$/.test(coin.amount ?? "")) balances.set(coin.denom, BigInt(coin.amount as string));
          }
          setState({ address, balances });
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener("qwakk:tx-confirmed", load);
    return () => { active = false; window.removeEventListener("qwakk:tx-confirmed", load); };
  }, [address]);

  return state && state.address === address ? state.balances : null;
}
