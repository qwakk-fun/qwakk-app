export const QORECHAIN_DIANA = "qorechain-diana";

export type QoreXNativeProvider = {
  enable: (chainId: string) => Promise<void>;
  getKey: (chainId: string) => Promise<{ bech32Address: string }>;
};

declare global {
  interface Window {
    qorex?: { native?: QoreXNativeProvider };
  }
}
