import { getQwakkNetwork } from "@/lib/qwakk-network";

/**
 * Server-side endpoint constants, kept under their original names for existing
 * imports. They follow `QWAKK_NETWORK` (see `lib/qwakk-network.ts`).
 */
const network = getQwakkNetwork();

export const QORECHAIN_NETWORK = network;
export const QORECHAIN_CHAIN_ID = network.chainId;
export const QORECHAIN_REST_URL = network.restUrl;
export const QORECHAIN_RPC_URL = network.rpcUrl;
export const QORECHAIN_EVM_RPC_URL = network.evmRpcUrl;
