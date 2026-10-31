"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { DEFAULT_QWAKK_NETWORK_ID, QWAKK_NETWORK_PRESETS, publicNetwork, type PublicQwakkNetwork } from "../lib/qwakk-network";
import { networkCopy } from "../lib/qwakk-tx-copy";
import { useFeatures } from "./useFeatures";

/**
 * The server's network, handed down by the root layout so the first render
 * (server HTML included) already names the right network. Labels only: the
 * chain id a wallet is asked for still comes from `/api/features`.
 */
const NetworkContext = createContext<PublicQwakkNetwork | null>(null);

export function NetworkProvider({ network, children }: { network: PublicQwakkNetwork; children: ReactNode }) {
  return <NetworkContext.Provider value={network}>{children}</NetworkContext.Provider>;
}

const FALLBACK = publicNetwork(QWAKK_NETWORK_PRESETS[DEFAULT_QWAKK_NETWORK_ID]);

/**
 * The network for copy: `/api/features` once it answers, the layout's value
 * before that. `copy` swaps "QoreChain Diana" in fixed lines for this network's label.
 */
export function useNetworkCopy() {
  const loaded = useFeatures().network;
  const server = useContext(NetworkContext);
  const network = loaded ?? server ?? FALLBACK;
  const copy = useCallback((text: string) => networkCopy(text, network), [network]);
  return { network, label: network.label, isTestnet: network.id === "testnet", copy };
}
