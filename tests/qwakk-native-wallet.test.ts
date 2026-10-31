import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { executeNativeAction, type TxState } from "../components/useNativeTransaction";
import { readQoreXSigner, type QoreXNativeProvider } from "../lib/qorex-native";
import type { NativeAction } from "../lib/qwakk-native-actions";
import {
  QOREX_ACCOUNT_CHANGED_COPY,
  QOREX_DECLINED_COPY,
  QOREX_LOCKED_COPY,
  QOREX_PENDING_COPY,
  WALLET_ACCOUNT_SWITCHED_COPY,
  isQuietWalletStop,
  walletFailure,
} from "../lib/qwakk-tx-copy";
import { WALLET_ADDRESS_KEY } from "../lib/qwakk-wallet-session";

const ACTIVE = `qor1${"q".repeat(38)}`;
const OTHER = `qor1${"p".repeat(38)}`;
const CHAIN_ID = "qorechain-diana";
const HASH = "AB".repeat(32);
const ACTION = { kind: "swap" } as unknown as NativeAction;

type Calls = { enable: number; getKey: number; signAndBroadcast: number; listAccounts: number };

/** A QoreX 0.3.9-shaped provider that counts every call. */
function mockQoreX(options: { address?: string; getKeyError?: Error; signError?: Error } = {}) {
  const calls: Calls = { enable: 0, getKey: 0, signAndBroadcast: 0, listAccounts: 0 };
  const provider: QoreXNativeProvider = {
    capabilities: ["listAccounts", "connectProofPicksAccount", "executeRequest", "signAndBroadcast"],
    enable: async () => { calls.enable += 1; },
    getKey: async () => {
      calls.getKey += 1;
      if (options.getKeyError) throw options.getKeyError;
      return { bech32Address: options.address ?? ACTIVE, pubKey: [] };
    },
    signAndBroadcast: async () => {
      calls.signAndBroadcast += 1;
      if (options.signError) throw options.signError;
      return { txHash: HASH, code: 0, height: "123", shield: "shielded" };
    },
    listAccounts: async () => {
      calls.listAccounts += 1;
      return { accounts: [{ index: 0, label: "", address: options.address ?? ACTIVE }], activeIndex: 0 };
    },
  };
  return { provider, calls };
}

/** A browser stand-in: localStorage, events and the injected QoreX provider. */
function installBrowser(provider: QoreXNativeProvider, stored = ACTIVE) {
  const storage = new Map<string, string>(stored ? [[WALLET_ADDRESS_KEY, stored]] : []);
  const prepareCalls: unknown[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    qorex: { native: provider },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    dispatchEvent: () => true,
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/features")) {
      return Response.json({ actions: { swap: true }, points: false, network: { id: "testnet", label: "QoreChain Diana", chainId: CHAIN_ID } });
    }
    if (url.startsWith("/api/native-tx/prepare")) {
      prepareCalls.push(JSON.parse(String(init?.body)));
      return Response.json({
        chainId: CHAIN_ID,
        messages: [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: "AA==" }],
        memo: "",
        gasLimit: "200000",
        fee: { amount: "30000" },
        interfaceFee: null,
        pqcKeyRegistered: true,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { storage, prepareCalls };
}

async function run() {
  let state = { phase: "idle" } as TxState;
  await executeNativeAction(ACTION, (update) => { state = typeof update === "function" ? update(state) : update; });
  return state;
}

async function quietly<T>(work: () => Promise<T>) {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
}

test("an action with an unlocked, approved QoreX makes one getKey and one signAndBroadcast call, nothing else", async () => {
  const { provider, calls } = mockQoreX();
  const { prepareCalls } = installBrowser(provider);
  const state = await run();
  assert.equal(state.phase, "success");
  assert.equal(state.txhash, HASH);
  assert.deepEqual(calls, { enable: 0, getKey: 1, signAndBroadcast: 1, listAccounts: 0 });
  assert.equal((prepareCalls[0] as { address: string }).address, ACTIVE);
});

test("a locked QoreX stops after one silent getKey, with calm copy and no approval window", async () => {
  const { provider, calls } = mockQoreX({ getKeyError: new Error("QoreX: wallet is locked") });
  const { prepareCalls } = installBrowser(provider);
  const state = await run();
  assert.deepEqual(calls, { enable: 0, getKey: 1, signAndBroadcast: 0, listAccounts: 0 });
  assert.equal(prepareCalls.length, 0);
  assert.equal(state.phase, "failed");
  assert.equal(state.message, QOREX_LOCKED_COPY);
  assert.equal(state.quiet, true);
});

test("an account switched inside QoreX is caught by the single getKey before anything is prepared", async () => {
  const { provider, calls } = mockQoreX({ address: OTHER });
  const { storage, prepareCalls } = installBrowser(provider, ACTIVE);
  const state = await run();
  assert.deepEqual(calls, { enable: 0, getKey: 1, signAndBroadcast: 0, listAccounts: 0 });
  assert.equal(prepareCalls.length, 0);
  assert.equal(storage.get(WALLET_ADDRESS_KEY), OTHER);
  assert.equal(state.message, WALLET_ACCOUNT_SWITCHED_COPY);
  assert.equal(state.quiet, true);
});

test("declining the QoreX approval is a calm stop, not a failed transaction", async () => {
  const { provider, calls } = mockQoreX({ signError: new Error("QoreX: signature rejected") });
  installBrowser(provider);
  const state = await quietly(run);
  assert.deepEqual(calls, { enable: 0, getKey: 1, signAndBroadcast: 1, listAccounts: 0 });
  assert.equal(state.message, QOREX_DECLINED_COPY);
  assert.equal(state.quiet, true);
  assert.equal(state.txhash, "");
});

test("a chain refusal after approval stays a real failure", async () => {
  const { provider } = mockQoreX({ signError: new Error("Transaction rejected by the network (sdk 5): insufficient funds") });
  installBrowser(provider);
  const state = await quietly(run);
  assert.equal(state.phase, "failed");
  assert.equal(state.quiet, false);
});

test("readQoreXSigner makes exactly one getKey call and refuses a missing address", async () => {
  const { provider, calls } = mockQoreX();
  assert.equal(await readQoreXSigner(provider, CHAIN_ID), ACTIVE);
  assert.deepEqual(calls, { enable: 0, getKey: 1, signAndBroadcast: 0, listAccounts: 0 });
  await assert.rejects(readQoreXSigner(mockQoreX({ address: "not-an-address" }).provider, CHAIN_ID));
});

test("QoreX 0.3.9 wallet stops map to calm controlled copy", () => {
  const cases: Array<[string, string, string]> = [
    ["QoreX: wallet is locked", "locked", QOREX_LOCKED_COPY],
    ["QoreX: signature rejected", "declined", QOREX_DECLINED_COPY],
    ["QoreX: connection rejected", "declined", QOREX_DECLINED_COPY],
    ["QoreX: a request from this site is already waiting for your answer.", "pending", QOREX_PENDING_COPY],
    ["QoreX: too many requests are waiting. Answer those first.", "pending", QOREX_PENDING_COPY],
    ["QoreX: the wallet or account changed while this request was waiting. Nothing was signed.", "account", QOREX_ACCOUNT_CHANGED_COPY],
  ];
  for (const [raw, kind, copy] of cases) {
    const failure = walletFailure(new Error(raw));
    assert.equal(failure.kind, kind, raw);
    assert.equal(failure.copy, copy, raw);
    assert.equal(isQuietWalletStop(failure.kind), true, raw);
    assert.doesNotMatch(failure.copy, /\u2014/);
  }
  assert.equal(isQuietWalletStop(walletFailure(new Error("Transaction failed on-chain (code 5).")).kind), false);
  assert.equal(isQuietWalletStop(walletFailure(new Error("QoreX: something new")).kind), false);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("no client code calls QoreX listAccounts or touches QoreX from focus or visibility handlers", () => {
  const root = join(import.meta.dirname, "..");
  for (const file of [...sourceFiles(join(root, "app")), ...sourceFiles(join(root, "components"))]) {
    const source = readFileSync(file, "utf8");
    // QoreX 0.3.9 asks to connect the site before it checks the lock, so this read can open the unlock screen.
    assert.doesNotMatch(source, /\.listAccounts\s*\(/, `${file} calls listAccounts`);
    if (/addEventListener\(\s*["'](focus|visibilitychange)["']/.test(source)) {
      assert.doesNotMatch(source, /qorex|getKey|\.enable\(/i, `${file} talks to QoreX from a focus or visibility handler`);
    }
  }
});
