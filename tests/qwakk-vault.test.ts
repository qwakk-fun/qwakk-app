import assert from "node:assert/strict";
import test from "node:test";

import {
  POND_VAULT_SELECTORS,
  POND_VAULT_TOPICS,
  ZERO_ADDRESS,
  decodeAction,
  displayAmount,
  encodeCall,
  formatBaseUnits,
  words,
} from "../lib/qwakk-vault-abi";
import { parseWindow, readVaultSnapshot, vaultAddressFromEnv, vaultTokens, type VaultActionRow } from "../lib/qwakk-vault";
import { VAULT_GRACE_SECONDS, vaultActionState, vaultDuration } from "../lib/qwakk-vault-view";

const VAULT = "0x1234567890abcdef1234567890abcdef12345678";
const OWNER = "0x00000000000000000000000000000000000000a1";
const GUARD = "0x00000000000000000000000000000000000000b2";
const RECIPIENT = "0x00000000000000000000000000000000000000c3";

const w = (value: bigint | number | string) => {
  if (typeof value === "string") return value.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(value).toString(16).padStart(64, "0");
};
const ret = (...parts: (bigint | number | string)[]) => `0x${parts.map(w).join("")}`;

test("vault address comes only from a valid env value on the testnet", () => {
  assert.equal(vaultAddressFromEnv({ QWAKK_VAULT_ADDRESS: VAULT }, "testnet"), VAULT);
  assert.equal(vaultAddressFromEnv({ QWAKK_VAULT_ADDRESS: ` ${VAULT} ` }, "testnet"), VAULT);
  assert.equal(vaultAddressFromEnv({ QWAKK_VAULT_ADDRESS: VAULT }, "mainnet"), null);
  assert.equal(vaultAddressFromEnv({ QWAKK_VAULT_ADDRESS: "qor1abc" }, "testnet"), null);
  assert.equal(vaultAddressFromEnv({ QWAKK_VAULT_ADDRESS: ZERO_ADDRESS }, "testnet"), null);
  assert.equal(vaultAddressFromEnv({}, "testnet"), null);
});

test("vault tokens follow the Diana registry", () => {
  assert.deepEqual(vaultTokens().map((t) => [t.symbol, t.token, t.decimals]), [
    ["fUSD", "0x97143B771D34ddb9130b807b135Ae675A5a963CA", 6],
    ["fETH", "0x02292293c13880a26242690eb70a0e42B8E91c28", 18],
    ["fBTC", "0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A", 8],
  ]);
});

test("calldata and decoding", () => {
  assert.equal(encodeCall("owner()"), POND_VAULT_SELECTORS["owner()"]);
  assert.equal(encodeCall("dailyCap(address)", VAULT), `0x3e3e7973${"0".repeat(24)}${VAULT.slice(2)}`);
  assert.equal(encodeCall("getAction(uint256)", BigInt(3)), `0xb6e76873${"0".repeat(63)}3`);
  assert.throws(() => encodeCall("dailyCap(address)", "0x12"));
  assert.throws(() => encodeCall("getAction(uint256)", -BigInt(1)));
  assert.throws(() => words("0x1234"));
  const a = decodeAction(ret(1, 2, 4, 1_900_000_000, ZERO_ADDRESS, RECIPIENT, BigInt(10) ** BigInt(18)));
  assert.deepEqual(a, { action: "Withdraw", status: "executed", nonce: BigInt(4), eta: BigInt(1_900_000_000), token: ZERO_ADDRESS, to: RECIPIENT, amount: BigInt(10) ** BigInt(18) });
  assert.throws(() => decodeAction(ret(9, 0, 0, 0, 0, 0, 0)));
});

test("amounts are formatted with integer math", () => {
  assert.equal(formatBaseUnits(BigInt(15) * BigInt(10) ** BigInt(17), 18), "1.5");
  assert.equal(formatBaseUnits(BigInt(123_456_789), 6), "123.456789");
  assert.equal(formatBaseUnits(BigInt(1_000_000_000_000), 6), "1,000,000");
  assert.equal(formatBaseUnits(BigInt(10) ** BigInt(30) + BigInt(1), 18, 2), "1,000,000,000,000");
  assert.equal(displayAmount(BigInt(5), 18), "<0.000001");
  assert.equal(displayAmount(BigInt(0), 6), "0");
});

test("window scope is read from the REST answer", () => {
  const base = { found: true, live: true, remaining_blocks: "500", remaining_txs: "3", native_only: false };
  assert.deepEqual(parseWindow({ ...base, allowed_targets: [VAULT.toUpperCase().replace("0X", "0x")] }, VAULT), { found: true, live: true, remainingBlocks: "500", remainingTxs: "3", scope: "vault" });
  assert.equal(parseWindow({ ...base, allowed_targets: [] }, VAULT)?.scope, "unscoped");
  assert.equal(parseWindow({ ...base, allowed_targets: [OWNER] }, VAULT)?.scope, "elsewhere");
  assert.equal(parseWindow({ ...base, native_only: true, allowed_targets: [] }, VAULT)?.scope, "native-only");
  assert.equal(parseWindow({ found: "yes" }, VAULT), null);
  assert.equal(parseWindow(null, VAULT), null);
});

type Rpc = { id: number; method: string; params: unknown[] };

/** A fake QoreChain: answers the vault's batch calls and the window REST route. */
function fakeChain(opts: { code?: boolean; logsFail?: boolean; tokenReverts?: boolean } = {}) {
  const tokens = vaultTokens();
  const queuedHash = `0x${"a".repeat(64)}`;
  const settledHash = `0x${"b".repeat(64)}`;
  const answer = (r: Rpc): unknown => {
    if (r.method === "eth_getBlockByNumber") return { number: "0x989680", timestamp: "0x7000" };
    if (r.method === "eth_getBalance") return "0xde0b6b3a7640000"; // 1 QOR
    if (r.method === "eth_getLogs") {
      if (opts.logsFail) throw new Error("range");
      return [
        { topics: [POND_VAULT_TOPICS["ActionQueued(uint256,uint8,address,address,uint256,uint64,uint64)"], `0x${w(2)}`, `0x${w(1)}`], transactionHash: queuedHash },
        { topics: [POND_VAULT_TOPICS["ActionExecuted(uint256,uint8)"].toUpperCase().replace("0X", "0x"), `0x${w(2)}`, `0x${w(1)}`], transactionHash: settledHash },
      ];
    }
    const { to, data } = (r.params[0] as { to: string; data: string });
    if (opts.code === false) return "0x";
    const sel = data.slice(0, 10);
    if (to.toLowerCase() !== VAULT) {
      if (opts.tokenReverts) throw new Error("execution reverted");
      return ret(tokens.findIndex((t) => t.token.toLowerCase() === to.toLowerCase()) + 7);
    }
    switch (sel) {
      case POND_VAULT_SELECTORS["owner()"]: return ret(OWNER);
      case POND_VAULT_SELECTORS["approver()"]: return ret(OWNER);
      case POND_VAULT_SELECTORS["guardian()"]: return ret(GUARD);
      case POND_VAULT_SELECTORS["paused()"]: return ret(0);
      case POND_VAULT_SELECTORS["timelock()"]: return ret(600);
      case POND_VAULT_SELECTORS["nonce()"]: return ret(2);
      case POND_VAULT_SELECTORS["actionCount()"]: return ret(2);
      case POND_VAULT_SELECTORS["dailyCap(address)"]: return ret(BigInt(5) * BigInt(10) ** BigInt(18));
      case POND_VAULT_SELECTORS["remainingToday(address)"]: return ret(BigInt(4) * BigInt(10) ** BigInt(18));
      case POND_VAULT_SELECTORS["keyStatus(address)"]: return ret(1, 64, 0);
      case POND_VAULT_SELECTORS["getAction(uint256)"]: {
        const id = BigInt(`0x${data.slice(10)}`);
        return id === BigInt(2) ? ret(1, 2, 1, 0x6000, ZERO_ADDRESS, RECIPIENT, BigInt(10) ** BigInt(17)) : ret(2, 1, 0, 0x7100, tokens[0].token, ZERO_ADDRESS, BigInt(1_000_000_000));
      }
      default: throw new Error(`unexpected ${sel}`);
    }
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/qorechain/pqc/v1/evm_window/")) {
      assert.match(href, /evm_window\/qor-of-0x00000000000000000000000000000000000000a1$/);
      return new Response(JSON.stringify({ found: true, live: true, remaining_blocks: "100", remaining_txs: "2", native_only: false, allowed_targets: [VAULT] }));
    }
    const batch = JSON.parse(String(init?.body)) as Rpc[];
    return new Response(JSON.stringify(batch.map((r) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: answer(r) };
      } catch {
        return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "raw node text" } };
      }
    })));
  }) as typeof fetch;
  return { fetchImpl, queuedHash, settledHash };
}

const config = (fetchImpl: typeof fetch) => ({
  vault: VAULT,
  evmRpcUrl: "https://evm.example",
  restUrl: "https://rest.example",
  toQorAddress: (evm: string) => `qor-of-${evm}`,
  fetch: fetchImpl,
});

test("reads a full snapshot from the chain", async () => {
  const chain = fakeChain();
  const s = await readVaultSnapshot(config(chain.fetchImpl));
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.owner, OWNER);
  assert.equal(s.guardian, GUARD);
  assert.equal(s.timelockSeconds, 600);
  assert.equal(s.nonce, "2");
  assert.equal(s.chainTime, 0x7000);
  assert.equal(s.approverKeyUsable, true);
  assert.deepEqual(s.assets[0], { symbol: "QOR", denom: "uqor", token: ZERO_ADDRESS, balance: "1", dailyCap: "5", remainingToday: "4", remainingTodayRaw: (BigInt(4) * BigInt(10) ** BigInt(18)).toString() });
  assert.deepEqual(s.assets.map((a) => a.symbol), ["QOR", "fUSD", "fETH", "fBTC"]);
  assert.equal(s.assets[1].balance, "0.000007"); // 7 base units of a 6-decimal token
  assert.deepEqual(s.actions.map((a) => [a.id, a.action, a.status]), [["2", "Withdraw", "executed"], ["1", "SetDailyCap", "queued"]]);
  assert.equal(s.actions[0].amount, "0.1");
  assert.equal(s.actions[0].amountRaw, (BigInt(10) ** BigInt(17)).toString());
  assert.equal(s.actions[0].token, ZERO_ADDRESS);
  assert.equal(s.actions[0].symbol, "QOR");
  assert.equal(s.actions[0].to, RECIPIENT);
  assert.equal(s.actions[0].queuedTx, chain.queuedHash);
  assert.equal(s.actions[0].settledTx, chain.settledHash);
  assert.equal(s.actions[1].amount, "1,000");
  assert.equal(s.actions[1].symbol, "fUSD");
  assert.equal(s.actions[1].to, null);
  assert.equal(s.ownerWindow?.scope, "vault");
});

test("a reverting token read only marks that balance unavailable", async () => {
  const s = await readVaultSnapshot(config(fakeChain({ tokenReverts: true }).fetchImpl));
  assert.equal(s.status, "ok");
  if (s.status !== "ok") return;
  assert.equal(s.assets[0].balance, "1");
  assert.deepEqual(s.assets.slice(1).map((a) => a.balance), ["Unavailable", "Unavailable", "Unavailable"]);
  assert.equal(s.assets[1].dailyCap, "5,000,000,000,000");
  assert.equal(s.actions.length, 2);
});

test("missing logs only drop the transaction links", async () => {
  const s = await readVaultSnapshot(config(fakeChain({ logsFail: true }).fetchImpl));
  assert.equal(s.status, "ok");
  if (s.status === "ok") assert.equal(s.actions[0].queuedTx, null);
});

test("an address without code, or a failing node, reads as unavailable without leaking text", async () => {
  assert.deepEqual(await readVaultSnapshot(config(fakeChain({ code: false }).fetchImpl)), { status: "unavailable" });
  const down = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  assert.deepEqual(await readVaultSnapshot(config(down)), { status: "unavailable" });
});

const row = (over: Partial<VaultActionRow> = {}): VaultActionRow => ({
  id: "1",
  action: "Withdraw",
  status: "queued",
  eta: 1_000,
  symbol: "QOR",
  token: ZERO_ADDRESS,
  to: RECIPIENT,
  amount: "2",
  amountRaw: (BigInt(2) * BigInt(10) ** BigInt(18)).toString(),
  queuedTx: null,
  settledTx: null,
  ...over,
});
const left = (qor: bigint) => ({ [ZERO_ADDRESS]: qor.toString() });
const ONE = BigInt(10) ** BigInt(18);

test("queue states follow what execute would do", () => {
  const open = { paused: false, remainingToday: left(BigInt(5) * ONE) };
  assert.deepEqual(vaultActionState(row(), 900, open), { label: "Ready in 1m 40s", tone: "wait" });
  assert.deepEqual(vaultActionState(row(), 1_000, open), { label: "Ready to execute", tone: "ready" });
  assert.deepEqual(vaultActionState(row({ status: "executed" }), 1_000, open), { label: "Executed", tone: "done" });
  assert.deepEqual(vaultActionState(row({ status: "cancelled" }), 1_000, open), { label: "Cancelled", tone: "off" });
  assert.deepEqual(vaultActionState(row(), 1_001 + VAULT_GRACE_SECONDS, open), { label: "Expired", tone: "off" });
});

test("withdrawals show as blocked while paused or over today's cap", () => {
  const paused = { paused: true, remainingToday: left(BigInt(5) * ONE) };
  assert.deepEqual(vaultActionState(row(), 1_000, paused), { label: "Blocked: vault paused", tone: "blocked" });
  assert.deepEqual(vaultActionState(row(), 10, paused), { label: "Blocked: vault paused", tone: "blocked" });
  // A pause blocks withdrawals only: rule changes still run.
  assert.deepEqual(vaultActionState(row({ action: "SetGuardian", token: null, amountRaw: null }), 1_000, paused), { label: "Ready to execute", tone: "ready" });

  const tight = { paused: false, remainingToday: left(ONE) };
  assert.deepEqual(vaultActionState(row(), 1_000, tight), { label: "Blocked: over today's cap", tone: "blocked" });
  assert.deepEqual(vaultActionState(row(), 940, tight), { label: "Ready in 1m 0s, over today's cap", tone: "wait" });
  assert.deepEqual(vaultActionState(row({ amountRaw: ONE.toString() }), 1_000, tight), { label: "Ready to execute", tone: "ready" });
  // A locked token (cap 0) blocks any amount; an unknown token is not guessed.
  assert.equal(vaultActionState(row(), 1_000, { paused: false, remainingToday: left(BigInt(0)) }).tone, "blocked");
  assert.equal(vaultActionState(row(), 1_000, { paused: false, remainingToday: {} }).tone, "ready");
});

test("durations read plainly", () => {
  assert.equal(vaultDuration(0), "0s");
  assert.equal(vaultDuration(45), "45s");
  assert.equal(vaultDuration(600), "10m 0s");
  assert.equal(vaultDuration(3_660), "1h 1m");
  assert.equal(vaultDuration(90_000), "1d 1h");
});
