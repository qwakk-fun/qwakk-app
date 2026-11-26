/**
 * Which QoreChain network QoreX is on, compared with the one this deployment
 * trades on (`QWAKK_NETWORK`, served by `/api/features`).
 *
 * QoreX 0.4.3 (`dist/background.js`) facts this module is built on:
 * - `native:getKey` and `native:enable` only check that the chain id is one
 *   QoreX supports (`requireChain`: qorechain-vladi or qorechain-diana). They
 *   never compare it with the active network, so `getKey("qorechain-diana")`
 *   answers with the address while QoreX is on mainnet. The address is the
 *   same `qor1` address on both networks.
 * - `native:signAndBroadcast` refuses a request whose chain id differs from the
 *   active network ("QoreX: chain X does not match the active network Y")
 *   before any approval window. That stays the last line of defence.
 * - The EVM lane's `eth_chainId` answers from the active network with no
 *   unlock, connection or window: "0x2648" (9800) on qorechain-diana and
 *   "0x2649" (9801) on qorechain-vladi (`evmChains()`). It is the only silent
 *   way a site can read QoreX's active network.
 * - Switching network inside QoreX (`setTestnet`, `setDeveloperMode`) notifies
 *   every tab, and the injected EVM provider then emits `chainChanged` with the
 *   new hex id (and a `qorex_keystorechange` window event). dApps cannot switch
 *   QoreX's network themselves ("switch the network in QoreX itself").
 */

import { QWAKK_NETWORK_PRESETS, type PublicQwakkNetwork, type QwakkNetworkId } from "./qwakk-network";

/** QoreX's EIP-1193 provider (`window.qorex.evm`), only the parts Qwakk reads. */
export type QoreXEvmProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

/** What QoreX reported: one of the known networks, or nothing Qwakk can trust. */
export type QoreXNetworkReading = { state: "known"; networkId: QwakkNetworkId; chainId: string } | { state: "unknown" };

/**
 * - "match": QoreX is on this deployment's network;
 * - "wrong": QoreX is on the other QoreChain network, so nothing may connect or sign;
 * - "unknown": QoreX did not say (no EVM lane, a timeout). Connecting goes on,
 *   and QoreX's own chain check in `signAndBroadcast` still refuses a mismatch.
 */
export type WalletNetworkCheck = "match" | "wrong" | "unknown";
export type WalletNetworkState = {
  check: WalletNetworkCheck;
  wallet: QwakkNetworkId | null;
  /**
   * True when the top bar should raise the switch steps itself: QoreX moved
   * while nothing else was on screen. A wallet action or the connect flow
   * shows the steps in its own place, so it leaves this false.
   */
  announce?: boolean;
};

export const WALLET_NETWORK_UNKNOWN: WalletNetworkState = { check: "unknown", wallet: null };

/** QoreX's EVM chain id (hex string or number) as one of Qwakk's network presets. */
export function walletNetworkFromEvmChainId(value: unknown): QoreXNetworkReading {
  const id = typeof value === "number" ? value : typeof value === "string" && /^0x[0-9a-f]+$/i.test(value.trim()) ? Number.parseInt(value.trim(), 16) : Number.NaN;
  if (!Number.isSafeInteger(id)) return { state: "unknown" };
  const preset = Object.values(QWAKK_NETWORK_PRESETS).find((network) => network.evmChainId === id);
  // Any other id (QoreX's Ethereum lane, a future chain) says nothing about the native network.
  return preset ? { state: "known", networkId: preset.id, chainId: preset.chainId } : { state: "unknown" };
}

/** Compares QoreX's network with the deployment's. Pure, so tests can call it. */
export function checkWalletNetwork(reading: QoreXNetworkReading, target: Pick<PublicQwakkNetwork, "chainId">): WalletNetworkState {
  if (reading.state !== "known") return WALLET_NETWORK_UNKNOWN;
  return { check: reading.chainId === target.chainId ? "match" : "wrong", wallet: reading.networkId };
}

const READ_TIMEOUT_MS = 4_000;

/**
 * Asks QoreX for its active network with `eth_chainId`: no window, no unlock
 * and no connection approval. Never throws; a missing EVM lane, an error or a
 * slow answer is "unknown".
 */
export async function readQoreXNetwork(evm: QoreXEvmProvider | undefined | null, timeoutMs = READ_TIMEOUT_MS): Promise<QoreXNetworkReading> {
  if (!evm || typeof evm.request !== "function") return { state: "unknown" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      evm.request({ method: "eth_chainId" }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return walletNetworkFromEvmChainId(answer);
  } catch {
    return { state: "unknown" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Calls `onChange` when QoreX switches network. QoreX's EVM provider emits
 * `chainChanged` with the new hex id after a switch inside QoreX. Returns the
 * cleanup.
 */
export function watchQoreXNetwork(evm: QoreXEvmProvider | undefined | null, onChange: (reading: QoreXNetworkReading) => void): () => void {
  if (!evm || typeof evm.on !== "function") return () => {};
  const listener = (value: unknown) => onChange(walletNetworkFromEvmChainId(value));
  try {
    evm.on("chainChanged", listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      evm.removeListener?.("chainChanged", listener);
    } catch {
      // The provider went away with the page.
    }
  };
}

/** The injected QoreX EVM provider, when there is one. */
export function qorexEvm(): QoreXEvmProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const evm = (window as unknown as { qorex?: { evm?: QoreXEvmProvider } }).qorex?.evm;
  return evm && typeof evm.request === "function" ? evm : undefined;
}

/** Reads QoreX's network and compares it with the deployment's in one step. */
export async function readWalletNetwork(target: Pick<PublicQwakkNetwork, "chainId">): Promise<WalletNetworkState> {
  return checkWalletNetwork(await readQoreXNetwork(qorexEvm()), target);
}

/*
 * The last known answer for this page, shared by the top bar (which shows
 * "Wrong network") and every wallet action (which re-checks before it signs).
 */
export const WALLET_NETWORK_EVENT = "qwakk:wallet-network";
let current: WalletNetworkState = WALLET_NETWORK_UNKNOWN;

export function readWalletNetworkState(): WalletNetworkState {
  return current;
}

export function setWalletNetworkState(next: WalletNetworkState) {
  if (next.check === current.check && next.wallet === current.wallet && Boolean(next.announce) === Boolean(current.announce)) return;
  current = next;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(WALLET_NETWORK_EVENT));
}
