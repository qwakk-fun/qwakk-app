import assert from "node:assert/strict";
import test from "node:test";

import { executeNativeAction, type TxState } from "../components/useNativeTransaction";
import type { QoreXNativeProvider } from "../lib/qorex-native";
import type { NativeAction } from "../lib/qwakk-native-actions";
import { QWAKK_NETWORK_PRESETS, publicNetwork } from "../lib/qwakk-network";
import {
  QOREX_MAINNET_NETWORK_COPY,
  QOREX_MOBILE_NETWORK_COPY,
  QOREX_NETWORK_COPY,
  WRONG_NETWORK_LABEL,
  isQuietWalletStop,
  qorexNetworkCopy,
  testnetTransactionCopy,
  walletConnectionCopy,
  walletFailure,
} from "../lib/qwakk-tx-copy";
import {
  WALLET_NETWORK_UNKNOWN,
  checkWalletNetwork,
  readQoreXNetwork,
  readWalletNetworkState,
  setWalletNetworkState,
  walletNetworkFromEvmChainId,
  watchQoreXNetwork,
  type QoreXEvmProvider,
} from "../lib/qwakk-wallet-network";
import { WALLET_ADDRESS_KEY } from "../lib/qwakk-wallet-session";

const testnet = publicNetwork(QWAKK_NETWORK_PRESETS.testnet);
const mainnet = publicNetwork(QWAKK_NETWORK_PRESETS.mainnet);
const ACTIVE = `qor1${"q".repeat(38)}`;
const HASH = "CD".repeat(32);
const ACTION = { kind: "swap" } as unknown as NativeAction;
/** QoreX 0.4.3 `evmChains()`: the EVM lane's id follows the active native network. */
const DIANA_HEX = "0x2648";
const VLADI_HEX = "0x2649";

test("QoreX's EVM chain id maps to Qwakk's network presets, and nothing else counts", () => {
  assert.deepEqual(walletNetworkFromEvmChainId(DIANA_HEX), { state: "known", networkId: "testnet", chainId: "qorechain-diana" });
  assert.deepEqual(walletNetworkFromEvmChainId(VLADI_HEX), { state: "known", networkId: "mainnet", chainId: "qorechain-vladi" });
  assert.deepEqual(walletNetworkFromEvmChainId(9800), { state: "known", networkId: "testnet", chainId: "qorechain-diana" });
  // QoreX's Ethereum lane or junk says nothing about the native network.
  for (const value of ["0x1", "0x", "2648", "", null, undefined, {}, Number.NaN]) {
    assert.deepEqual(walletNetworkFromEvmChainId(value), { state: "unknown" }, String(value));
  }
});

test("the guard follows the configured network: Diana on testnet, vladi on mainnet", () => {
  const onDiana = walletNetworkFromEvmChainId(DIANA_HEX);
  const onVladi = walletNetworkFromEvmChainId(VLADI_HEX);
  assert.deepEqual(checkWalletNetwork(onDiana, testnet), { check: "match", wallet: "testnet" });
  assert.deepEqual(checkWalletNetwork(onVladi, testnet), { check: "wrong", wallet: "mainnet" });
  assert.deepEqual(checkWalletNetwork(onVladi, mainnet), { check: "match", wallet: "mainnet" });
  assert.deepEqual(checkWalletNetwork(onDiana, mainnet), { check: "wrong", wallet: "testnet" });
  assert.deepEqual(checkWalletNetwork({ state: "unknown" }, testnet), WALLET_NETWORK_UNKNOWN);
});

test("reading QoreX's network asks only eth_chainId and never throws", async () => {
  const methods: string[] = [];
  const evm: QoreXEvmProvider = { request: async ({ method }) => { methods.push(method); return VLADI_HEX; } };
  assert.deepEqual(await readQoreXNetwork(evm), { state: "known", networkId: "mainnet", chainId: "qorechain-vladi" });
  assert.deepEqual(methods, ["eth_chainId"]);
  assert.deepEqual(await readQoreXNetwork(undefined), { state: "unknown" });
  assert.deepEqual(await readQoreXNetwork({ request: async () => { throw new Error("QoreX: something raw"); } }), { state: "unknown" });
  assert.deepEqual(await readQoreXNetwork({ request: () => new Promise(() => {}) }, 5), { state: "unknown" });
});

test("a network switch inside QoreX reaches the listener, and cleanup removes it", () => {
  const listeners = new Map<string, (value: unknown) => void>();
  const evm: QoreXEvmProvider = {
    request: async () => DIANA_HEX,
    on: (event, listener) => void listeners.set(event, listener as (value: unknown) => void),
    removeListener: (event) => void listeners.delete(event),
  };
  const seen: string[] = [];
  const stop = watchQoreXNetwork(evm, (reading) => seen.push(reading.state === "known" ? reading.chainId : "unknown"));
  listeners.get("chainChanged")?.(VLADI_HEX);
  listeners.get("chainChanged")?.(DIANA_HEX);
  assert.deepEqual(seen, ["qorechain-vladi", "qorechain-diana"]);
  stop();
  assert.equal(listeners.has("chainChanged"), false);
  // A provider without events is a no-op, not a crash.
  assert.doesNotThrow(() => watchQoreXNetwork({ request: async () => DIANA_HEX }, () => {})());
});

type Calls = { getKey: number; signAndBroadcast: number };

/** A browser with QoreX whose EVM lane answers from `chainIds`, one answer per read (the last repeats). */
function installBrowser(chainIds: string[] | null, signError?: Error) {
  const calls: Calls = { getKey: 0, signAndBroadcast: 0 };
  const native: QoreXNativeProvider = {
    capabilities: ["signAndBroadcast"],
    enable: async () => {},
    // QoreX 0.4.3 getKey only checks the chain id is supported, not that it is active.
    getKey: async () => { calls.getKey += 1; return { bech32Address: ACTIVE, pubKey: [] }; },
    signAndBroadcast: async () => {
      calls.signAndBroadcast += 1;
      if (signError) throw signError;
      return { txHash: HASH, code: 0, height: "9", shield: "shielded" };
    },
  };
  let read = 0;
  const evm: QoreXEvmProvider | undefined = chainIds ? { request: async () => chainIds[Math.min(read++, chainIds.length - 1)] } : undefined;
  const storage = new Map<string, string>([[WALLET_ADDRESS_KEY, ACTIVE]]);
  (globalThis as unknown as { window: unknown }).window = {
    qorex: { native, evm },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    dispatchEvent: () => true,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
  };
  let prepared = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/features")) return Response.json({ actions: { swap: true }, network: testnet });
    if (url.startsWith("/api/native-tx/prepare")) {
      prepared += 1;
      return Response.json({ chainId: testnet.chainId, messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: "AA==" }], memo: "", gasLimit: "200000", fee: { amount: "30000" }, interfaceFee: null, pqcKeyRegistered: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, prepared: () => prepared };
}

async function run() {
  let state = { phase: "idle" } as TxState;
  const original = console.error;
  console.error = () => {};
  try {
    await executeNativeAction(ACTION, (update) => { state = typeof update === "function" ? update(state) : update; });
  } finally {
    console.error = original;
  }
  return state;
}

test("QoreX on mainnet stops a testnet action before getKey, with the switch steps and nothing sent", async () => {
  setWalletNetworkState(WALLET_NETWORK_UNKNOWN);
  const { calls, prepared } = installBrowser([VLADI_HEX]);
  const state = await run();
  assert.deepEqual(calls, { getKey: 0, signAndBroadcast: 0 });
  assert.equal(prepared(), 0);
  assert.equal(state.phase, "failed");
  assert.equal(state.quiet, true);
  assert.equal(state.message, qorexNetworkCopy(testnet, false, "mainnet"));
  assert.deepEqual(readWalletNetworkState(), { check: "wrong", wallet: "mainnet" });
});

test("QoreX switching to mainnet while the transaction is prepared stops it before the approval window", async () => {
  const { calls, prepared } = installBrowser([DIANA_HEX, VLADI_HEX]);
  const state = await run();
  assert.deepEqual(calls, { getKey: 1, signAndBroadcast: 0 });
  assert.equal(prepared(), 1);
  assert.equal(state.message, qorexNetworkCopy(testnet, false, "mainnet"));
  assert.equal(readWalletNetworkState().check, "wrong");
});

test("QoreX on Diana signs as before and clears the wrong network state", async () => {
  setWalletNetworkState({ check: "wrong", wallet: "mainnet" });
  const { calls } = installBrowser([DIANA_HEX]);
  const state = await run();
  assert.equal(state.phase, "success");
  assert.deepEqual(calls, { getKey: 1, signAndBroadcast: 1 });
  assert.deepEqual(readWalletNetworkState(), { check: "match", wallet: "testnet" });
});

test("without an EVM lane QoreX's own chain refusal is the backstop, shown as the same calm copy", async () => {
  setWalletNetworkState(WALLET_NETWORK_UNKNOWN);
  const refusal = new Error("QoreX: chain qorechain-diana does not match the active network qorechain-vladi");
  const { calls } = installBrowser(null, refusal);
  const state = await run();
  assert.deepEqual(calls, { getKey: 1, signAndBroadcast: 1 });
  assert.equal(state.quiet, true);
  assert.equal(state.message, QOREX_NETWORK_COPY);
  assert.doesNotMatch(state.message, /qorechain-vladi|active network/);
  assert.equal(readWalletNetworkState().check, "wrong");
  setWalletNetworkState(WALLET_NETWORK_UNKNOWN);
});

test("wrong network copy says testnet only, names test tokens, gives the steps and stays controlled", () => {
  const lines = [
    QOREX_NETWORK_COPY,
    QOREX_MOBILE_NETWORK_COPY,
    QOREX_MAINNET_NETWORK_COPY,
    qorexNetworkCopy(testnet, false, "mainnet"),
    qorexNetworkCopy(testnet, true, "mainnet"),
    qorexNetworkCopy(mainnet, false, "testnet"),
    walletConnectionCopy(new Error("QoreX: chain qorechain-diana does not match the active network qorechain-vladi"), testnet),
    walletFailure(new Error("QoreX: unsupported chain cosmoshub-4"), testnet).copy,
    WRONG_NETWORK_LABEL,
    testnetTransactionCopy(testnet) ?? "",
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, /\u2014/, line);
    assert.doesNotMatch(line, /qorechain-vladi|cosmoshub|active network|unsupported chain/, line);
  }
  assert.match(QOREX_NETWORK_COPY, /QoreChain Diana testnet only \(test tokens, not real QOR\)/);
  assert.match(QOREX_NETWORK_COPY, /Developer mode, choose Switch to testnet \(diana\)/);
  assert.match(qorexNetworkCopy(testnet, false, "mainnet"), /^QoreX is on QoreChain mainnet\. /);
  assert.equal(qorexNetworkCopy(testnet, false, null), QOREX_NETWORK_COPY);
  assert.equal(qorexNetworkCopy(testnet, true), QOREX_MOBILE_NETWORK_COPY);
  assert.match(QOREX_MAINNET_NETWORK_COPY, /mainnet only/);
  assert.doesNotMatch(QOREX_MAINNET_NETWORK_COPY, /Diana/);
  assert.equal(walletFailure(new Error("QoreX: chain qorechain-diana does not match the active network qorechain-vladi"), testnet).kind, "network");
  assert.equal(isQuietWalletStop("network"), true);
});

test("the review line names the testnet and test tokens, and is absent on mainnet", () => {
  assert.equal(testnetTransactionCopy(testnet), "This transaction runs on QoreChain Diana with test tokens, not real QOR.");
  assert.equal(testnetTransactionCopy(mainnet), null);
});
