/**
 * The connected wallet address Qwakk shows balances, positions and points for.
 * It is only a public `qor1` address kept in this browser; keys stay in QoreX.
 *
 * Every page reads it from localStorage and listens for `WALLET_CHANGE_EVENT`,
 * so writing or clearing it here refreshes the whole app.
 */

export const WALLET_ADDRESS_KEY = "qwakk-wallet-address";
export const WALLET_CHANGE_EVENT = "qwakk:wallet-change";

export type WalletReconcile = "same" | "connected" | "switched";

function normal(address: string | null | undefined) {
  return (address ?? "").trim().toLowerCase();
}

/**
 * Compares the stored address with QoreX's active account.
 * - "same": nothing to do;
 * - "connected": nothing was stored, so the active account becomes the connected one;
 * - "switched": QoreX moved to another account, so what Qwakk shows belongs to
 *   the wrong account and must be replaced before anything is signed.
 */
export function reconcileWalletAddress(stored: string | null | undefined, active: string): WalletReconcile {
  const current = normal(stored);
  if (!current) return "connected";
  return current === normal(active) ? "same" : "switched";
}

export function readStoredWalletAddress(): string {
  try {
    return window.localStorage.getItem(WALLET_ADDRESS_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Stores the address and tells every page, but only when it changed. */
export function storeWalletAddress(address: string) {
  if (readStoredWalletAddress() === address) return;
  try {
    window.localStorage.setItem(WALLET_ADDRESS_KEY, address);
  } catch {
    // Storage blocked: the event still updates this page.
  }
  window.dispatchEvent(new Event(WALLET_CHANGE_EVENT));
}

/**
 * Forgets the connected address in Qwakk. QoreX's native lane has no
 * disconnect method (`@qorechain/qorex-types` 0.1.0 `QorexNativeProvider`), so
 * the site stays approved inside QoreX until the user removes it there.
 */
export function clearStoredWalletAddress() {
  try {
    window.localStorage.removeItem(WALLET_ADDRESS_KEY);
  } catch {
    // Storage blocked: the event still clears this page.
  }
  window.dispatchEvent(new Event(WALLET_CHANGE_EVENT));
}

/**
 * Brings the stored address in line with QoreX's active account. Returns what
 * happened, so a caller about to sign can stop when the account switched.
 */
export function syncStoredWalletAddress(active: string): WalletReconcile {
  const result = reconcileWalletAddress(readStoredWalletAddress(), active);
  if (result !== "same") storeWalletAddress(active);
  return result;
}
