"use client";

import { useCallback, useEffect, useState } from "react";
import {
  WALLET_ADDRESS_KEY,
  WALLET_CHANGE_EVENT,
  clearStoredWalletAddress,
  readStoredWalletAddress,
} from "../lib/qwakk-wallet-session";

/**
 * The connected address Qwakk shows, read from this browser only.
 *
 * This hook never calls QoreX: not on mount, focus, tab switch or a timer.
 * QoreX 0.3.9 can open a window from a read such as `listAccounts` (it asks
 * to connect the site before it checks the lock, and while locked that window
 * shows QoreX's unlock screen), and closing that window hands focus back to
 * the page, so a focus check turned into an unlock prompt loop. QoreX emits no
 * account change event, so an account switched inside QoreX is picked up on
 * the next wallet action instead: components/useNativeTransaction.ts reads the
 * active account once before it prepares anything and stops if it changed.
 *
 * `disconnect` clears the stored address; every page listening for
 * `qwakk:wallet-change` then drops that wallet's balances, positions and points.
 */
export function useWalletSession() {
  const [address, setAddress] = useState("");

  useEffect(() => {
    const restore = () => setAddress(readStoredWalletAddress());
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === WALLET_ADDRESS_KEY) restore(); };
    restore();
    window.addEventListener(WALLET_CHANGE_EVENT, restore);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WALLET_CHANGE_EVENT, restore);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const disconnect = useCallback(() => clearStoredWalletAddress(), []);

  return { address, disconnect };
}
