export const QORECHAIN_CHAIN_ID = "qorechain-diana";

export const QORECHAIN_REST_URL = (process.env.QORECHAIN_REST_URL ?? "https://api-testnet.qore.host").replace(/\/$/, "");
export const QORECHAIN_RPC_URL = (process.env.QORECHAIN_RPC_URL ?? "https://rpc-testnet.qore.host").replace(/\/$/, "");
