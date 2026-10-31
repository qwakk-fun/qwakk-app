/**
 * QoreX native provider types. The chain id passed to `enable`, `getKey` and
 * `signAndBroadcast` comes from the deployment's network (`/api/features`,
 * lib/qwakk-network.ts), never from a constant here.
 */

/** The QoreX capability Qwakk needs for every native action (QoreX 0.3.5 or newer). */
export const QOREX_SIGN_AND_BROADCAST = "signAndBroadcast";

/**
 * One protobuf-encoded message for `signAndBroadcast`. QoreX accepts the value
 * as base64, a byte array or a number array. Qwakk sends base64.
 */
export type QoreXMessage = { typeUrl: string; value: string };

export type QoreXSignAndBroadcastRequest = {
  /** Must equal the network active in QoreX, otherwise QoreX refuses before any approval. */
  chainId: string;
  /** 1 to 32 messages. Their sender must be the connected account. */
  messages: QoreXMessage[];
  memo?: string;
  /** QoreX clamps it to 100000..5000000 (default 400000) and prices the fee itself. */
  gasLimit?: string | number;
};

/**
 * `shield` reports whether the committed transaction carries the post-quantum
 * layer: "shielded" once the block includes it, "pending" if QoreX stopped
 * waiting before inclusion.
 */
export type QoreXSignAndBroadcastResult = {
  txHash: string;
  code: number;
  height?: number | string;
  shield?: "shielded" | "pending" | "downgraded" | "classical" | string;
};

/**
 * QoreX's native provider (`window.qorex.native`). Since 0.3.5 the wallet
 * builds, signs (classical plus ML-DSA post-quantum layer) and broadcasts the
 * transaction itself after the user approves it, so Qwakk never handles a
 * signature or a key. Bare `signDirect` is refused on QoreChain networks
 * without the post-quantum layer, so Qwakk does not use it.
 */
export type QoreXNativeProvider = {
  capabilities?: readonly string[];
  enable: (chainId: string) => Promise<void>;
  getKey: (chainId: string) => Promise<{ bech32Address: string; pubKey: number[]; pubKeyHex?: string }>;
  signAndBroadcast?: (request: QoreXSignAndBroadcastRequest) => Promise<QoreXSignAndBroadcastResult>;
  /**
   * Every account in the wallet ("read only. The site must be connected.",
   * `@qorechain/qorex-types` 0.1.0 `QorexNativeProvider.listAccounts`).
   *
   * Not silent. QoreX 0.3.9 handles `native:listAccounts` as
   * `ensureConnected(origin)` first and the lock check second, and while
   * locked it reads the connected-sites list under the pre-wallet storage key
   * (`wk()` has no `activeWalletId` until unlock), so a connected site can
   * look unconnected. The result is a connect window that opens on QoreX's
   * unlock screen. Qwakk does not call it; it stays typed only for reference.
   */
  listAccounts?: () => Promise<{ accounts: Array<{ index: number; label: string; address: string }>; activeIndex: number }>;
};

/**
 * The active QoreX account for one wallet action, in a single provider call.
 *
 * `getKey` "connects the site first if needed" (`@qorechain/qorex-types`
 * 0.1.0), so a separate `enable` adds a round trip and nothing else. In QoreX
 * 0.3.9 `getKey` checks the lock before anything else and rejects with
 * "QoreX: wallet is locked" without opening a window; once unlocked it opens
 * a window only for a site QoreX has not approved yet. An already approved
 * site gets the address with no prompt, so a normal action shows exactly one
 * QoreX window: the `signAndBroadcast` approval.
 */
export async function readQoreXSigner(wallet: Pick<QoreXNativeProvider, "getKey">, chainId: string): Promise<string> {
  const key = await wallet.getKey(chainId);
  const address = typeof key?.bech32Address === "string" ? key.bech32Address.trim() : "";
  if (!/^qor1[0-9a-z]{20,}$/.test(address)) throw new Error("QoreX: no account address");
  return address;
}

declare global {
  interface Window {
    qorex?: { native?: QoreXNativeProvider };
  }
}

export type QoreXSupport =
  | { state: "missing" }
  | { state: "outdated" }
  | { state: "ready"; wallet: QoreXNativeProvider & { signAndBroadcast: NonNullable<QoreXNativeProvider["signAndBroadcast"]> } };

/** Feature-detects the wallet-built transaction path instead of trusting a version string. */
export function qorexSupport(native: QoreXNativeProvider | undefined): QoreXSupport {
  if (!native) return { state: "missing" };
  const advertised = Array.isArray(native.capabilities) && native.capabilities.includes(QOREX_SIGN_AND_BROADCAST);
  if (!advertised || typeof native.signAndBroadcast !== "function") return { state: "outdated" };
  return { state: "ready", wallet: native as Extract<QoreXSupport, { state: "ready" }>["wallet"] };
}
