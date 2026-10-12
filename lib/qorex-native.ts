export const QORECHAIN_DIANA = "qorechain-diana";

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
};

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
