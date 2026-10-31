/**
 * The QoreChain network Qwakk runs against, chosen at runtime by
 * `QWAKK_NETWORK=testnet|mainnet` (default testnet).
 *
 * Preset values come from https://docs.qorechain.io/appendix/networks
 * ("Networks at a glance" and "Public endpoints") and match the chain ids in
 * `@qorechain/sdk` 0.8.2 (`dist/index.js` NETWORKS: `qorechain-diana`,
 * `qorechain-vladi`). Live check 2026-10-31: `https://rpc.qore.host/status`
 * reports `node_info.network` `qorechain-vladi`, `https://rpc-testnet.qore.host/status`
 * reports `qorechain-diana`, and `https://evm.qore.host` answers `eth_chainId`
 * `0x2649` (9801).
 *
 * The presets are plain data, so the browser can import this module. Only
 * `getQwakkNetwork()` reads the environment, and only the server calls it; the
 * browser learns the network from `/api/features`.
 */

export type QwakkNetworkId = "testnet" | "mainnet";

export type QwakkNetwork = {
  id: QwakkNetworkId;
  /** Shown to people. CLAUDE.md: the testnet is "QoreChain Diana". */
  label: string;
  /** Cosmos chain id. QoreX accepts only these two (docs: developer-tools/qorex-integrations#networks). */
  chainId: string;
  restUrl: string;
  rpcUrl: string;
  evmRpcUrl: string;
  /** EIP-155 chain id of the EVM lane. Informational: Qwakk trades on the native rail only. */
  evmChainId: number;
  /** Every transaction link is `${explorerUrl}/tx/<hash>`. */
  explorerUrl: string;
};

/** The part of the network the browser needs. */
export type PublicQwakkNetwork = Pick<QwakkNetwork, "id" | "label" | "chainId">;

export const QWAKK_EXPLORER_URL = "https://explore.qore.network";

export const QWAKK_NETWORK_PRESETS: Readonly<Record<QwakkNetworkId, QwakkNetwork>> = {
  testnet: {
    id: "testnet",
    label: "QoreChain Diana",
    chainId: "qorechain-diana",
    restUrl: "https://api-testnet.qore.host",
    rpcUrl: "https://rpc-testnet.qore.host",
    evmRpcUrl: "https://evm-testnet.qore.host",
    evmChainId: 9800,
    explorerUrl: QWAKK_EXPLORER_URL,
  },
  mainnet: {
    id: "mainnet",
    label: "QoreChain",
    chainId: "qorechain-vladi",
    restUrl: "https://api.qore.host",
    rpcUrl: "https://rpc.qore.host",
    evmRpcUrl: "https://evm.qore.host",
    evmChainId: 9801,
    explorerUrl: QWAKK_EXPLORER_URL,
  },
};

export const DEFAULT_QWAKK_NETWORK_ID: QwakkNetworkId = "testnet";

export type NetworkEnv = Readonly<Record<string, string | undefined>>;

function cleanUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

type EndpointKey = "restUrl" | "rpcUrl" | "evmRpcUrl";

const ENDPOINT_OVERRIDES: ReadonlyArray<[EndpointKey, string]> = [
  ["restUrl", "QORECHAIN_REST_URL"],
  ["rpcUrl", "QORECHAIN_RPC_URL"],
  ["evmRpcUrl", "QORECHAIN_EVM_RPC_URL"],
];

/**
 * Resolves the network from environment values. Pure, so tests can call it.
 *
 * - An unknown `QWAKK_NETWORK` falls back to the testnet with a warning, so a
 *   typo never points real funds at an unintended network.
 * - `QORECHAIN_REST_URL`, `QORECHAIN_RPC_URL` and `QORECHAIN_EVM_RPC_URL`
 *   still override the preset (for example a private node), except when the
 *   value is exactly the other network's public endpoint: that is a leftover
 *   from switching networks, so it is ignored with a warning. The live chain
 *   id guard (`lib/qwakk-chain-guard.ts`) catches any other mismatch.
 */
export function resolveQwakkNetwork(env: NetworkEnv): { network: QwakkNetwork; warnings: string[] } {
  const warnings: string[] = [];
  const raw = env.QWAKK_NETWORK?.trim().toLowerCase() ?? "";
  let id: QwakkNetworkId = DEFAULT_QWAKK_NETWORK_ID;
  if (raw === "testnet" || raw === "mainnet") id = raw;
  else if (raw) warnings.push(`QWAKK_NETWORK="${raw}" is not testnet or mainnet. Using ${DEFAULT_QWAKK_NETWORK_ID}.`);

  const preset = QWAKK_NETWORK_PRESETS[id];
  const other = QWAKK_NETWORK_PRESETS[id === "mainnet" ? "testnet" : "mainnet"];
  const network: QwakkNetwork = { ...preset };
  for (const [key, name] of ENDPOINT_OVERRIDES) {
    const value = env[name]?.trim();
    if (!value) continue;
    const url = cleanUrl(value);
    if (!isHttpUrl(url)) {
      warnings.push(`${name} is not an http(s) URL. Using the ${id} default.`);
      continue;
    }
    if (url === other[key]) {
      warnings.push(`${name} points at the ${other.id} endpoint while QWAKK_NETWORK is ${id}. Using the ${id} default.`);
      continue;
    }
    network[key] = url;
  }
  return { network, warnings };
}

let cached: QwakkNetwork | null = null;

/** The server's network, resolved once per process from `process.env`. */
export function getQwakkNetwork(): QwakkNetwork {
  if (cached) return cached;
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const { network, warnings } = resolveQwakkNetwork(env);
  for (const warning of warnings) console.warn(`[qwakk-network] ${warning}`);
  cached = network;
  return network;
}

export function publicNetwork(network: QwakkNetwork): PublicQwakkNetwork {
  return { id: network.id, label: network.label, chainId: network.chainId };
}

/** Transaction links always use explore.qore.network/tx/<hash> (CLAUDE.md, Product safeguards). */
export function explorerTxUrl(hash: string) {
  return `${QWAKK_EXPLORER_URL}/tx/${hash}`;
}

/**
 * Mainnet never signs against Qwakk's local x*y=k estimate: a swap there needs
 * QoreChain's own QuoteExactIn answer.
 */
export function requiresChainQuote(network: Pick<QwakkNetwork, "id">) {
  return network.id === "mainnet";
}
