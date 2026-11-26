"use client";

import { useEffect, useState } from "react";
import type { PublicQwakkNetwork } from "../lib/qwakk-network";
import {
  WALLET_NETWORK_EVENT,
  WALLET_NETWORK_UNKNOWN,
  checkWalletNetwork,
  qorexEvm,
  readQoreXNetwork,
  readWalletNetworkState,
  setWalletNetworkState,
  watchQoreXNetwork,
  type WalletNetworkState,
} from "../lib/qwakk-wallet-network";

/**
 * Whether QoreX is on the deployment's network, while a wallet is connected.
 *
 * Reads QoreX's network once when a connected wallet loads, then follows
 * QoreX's `chainChanged` event. Both go through the EVM lane's `eth_chainId`,
 * which QoreX answers without a window, an unlock or a connection prompt, so
 * this never opens QoreX (unlike `listAccounts`, see useWalletSession.ts). A
 * wallet action re-checks on its own before it signs.
 */
export function useWalletNetwork(address: string, target: PublicQwakkNetwork | null): WalletNetworkState {
  const [state, setState] = useState<WalletNetworkState>(WALLET_NETWORK_UNKNOWN);

  useEffect(() => {
    const sync = () => setState(readWalletNetworkState());
    sync();
    window.addEventListener(WALLET_NETWORK_EVENT, sync);
    return () => window.removeEventListener(WALLET_NETWORK_EVENT, sync);
  }, []);

  const chainId = target?.chainId ?? "";
  useEffect(() => {
    if (!address || !chainId) return;
    let active = true;
    const evm = qorexEvm();
    // Found here, with no action running: the top bar raises the switch steps.
    const apply = (reading: Parameters<typeof checkWalletNetwork>[0]) => { if (active) setWalletNetworkState({ ...checkWalletNetwork(reading, { chainId }), announce: true }); };
    void readQoreXNetwork(evm).then(apply);
    const stop = watchQoreXNetwork(evm, apply);
    return () => { active = false; stop(); };
  }, [address, chainId]);

  return address ? state : WALLET_NETWORK_UNKNOWN;
}
