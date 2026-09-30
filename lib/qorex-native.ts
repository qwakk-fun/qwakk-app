export const QORECHAIN_DIANA = "qorechain-diana";

export type QoreXSignDoc = {
  bodyBytes: number[];
  authInfoBytes: number[];
  chainId: string;
  accountNumber: string;
};

/**
 * QoreX's native provider. Unlike Keplr, `signDirect` takes the signer and the
 * sign doc only; the chain is read from the doc. It returns the classical
 * eth_secp256k1 signature and never adds a post-quantum layer itself.
 */
export type QoreXNativeProvider = {
  enable: (chainId: string) => Promise<void>;
  getKey: (chainId: string) => Promise<{ bech32Address: string; pubKey: number[]; pubKeyHex?: string }>;
  signDirect: (signerAddress: string, signDoc: QoreXSignDoc) => Promise<{
    signature: { signature: string };
    signed: { bodyBytes: number[]; authInfoBytes: number[]; chainId: string; accountNumber: string };
  }>;
};

declare global {
  interface Window {
    qorex?: { native?: QoreXNativeProvider };
  }
}
