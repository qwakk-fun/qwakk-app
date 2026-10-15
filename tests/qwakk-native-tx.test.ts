import assert from "node:assert/strict";
import test from "node:test";

import { amm, bank, qorechainRegistry } from "@qorechain/sdk";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import {
  PQC_GAS_HEADROOM,
  QOREX_MAX_GAS,
  QOREX_MIN_GAS,
  balanceShortfall,
  buildSimulationTx,
  bytesToBase64,
  classifySimulationError,
  encodeAsAny,
  findAccountSequence,
  gasLimitForSimulatedGas,
  networkFeeForGas,
  parseCoins,
  parseSimulationEvents,
  prepareWalletTx,
  requiredSpend,
  simulatedOutcome,
  toWalletMessages,
} from "../lib/qwakk-native-tx";
import { qorexSupport } from "../lib/qorex-native";
import { QOREX_NETWORK_COPY, SIMULATION_FAILURE_COPY, QUOTE_BLOCK_COPY, QUOTE_FAILURE_COPY, chainFailureCopy, walletFailure } from "../lib/qwakk-tx-copy";

const sender = "qor1exampleaddress000000000000";
const fromBase64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));
const swapMessage = amm.swapExactIn({ sender, poolId: "1", tokenIn: { denom: "uqor", amount: "10" }, denomOut: "utest", minOut: "1" });

test("encodes messages as base64 protobuf that decodes back to the same message", () => {
  const [wallet] = toWalletMessages(encodeAsAny([swapMessage]));
  assert.equal(wallet.typeUrl, "/qorechain.amm.v1.MsgSwapExactIn");
  assert.match(wallet.value, /^[A-Za-z0-9+/]+={0,2}$/);
  const decoded = qorechainRegistry().decode({ typeUrl: wallet.typeUrl, value: fromBase64(wallet.value) });
  assert.equal(decoded.sender, sender);
  assert.equal(decoded.poolId.toString(), "1");
  assert.deepEqual({ denom: decoded.tokenIn.denom, amount: decoded.tokenIn.amount }, { denom: "uqor", amount: "10" });
  assert.equal(decoded.minOut, "1");
});

test("builds a key-free simulation transaction that is never signed", () => {
  const raw = TxRaw.decode(buildSimulationTx(encodeAsAny([swapMessage]), BigInt(7), "memo"));
  const body = TxBody.decode(raw.bodyBytes);
  const authInfo = AuthInfo.decode(raw.authInfoBytes);
  assert.deepEqual(body.messages.map((message) => message.typeUrl), ["/qorechain.amm.v1.MsgSwapExactIn"]);
  assert.equal(body.memo, "memo");
  assert.equal(authInfo.signerInfos[0].publicKey, undefined);
  assert.equal(authInfo.signerInfos[0].sequence, BigInt(7));
  assert.deepEqual(raw.signatures, [new Uint8Array(64)]);
});

test("adds margin and post-quantum headroom to simulated gas, within QoreX's clamp", () => {
  // 89,318 is Diana's simulated gas for a classical 1 uqor self-transfer.
  assert.equal(gasLimitForSimulatedGas(BigInt(89_318)), BigInt(116_113) + PQC_GAS_HEADROOM);
  assert.equal(gasLimitForSimulatedGas(BigInt(0)), QOREX_MIN_GAS);
  assert.equal(gasLimitForSimulatedGas(BigInt(10_000_000)), QOREX_MAX_GAS);
});

test("prices the network fee exactly like QoreX 0.3.5", () => {
  // QoreX: (ceil(0.15 * 1e6) * gasLimit + 999999) / 1e6, in uqor.
  const wallet = (gas: bigint) => (BigInt(Math.ceil(0.15 * 1e6)) * gas + BigInt(999_999)) / BigInt(1_000_000);
  for (const gas of [100_000, 216_113, 400_000, 1_234_567, 5_000_000]) {
    assert.equal(networkFeeForGas(BigInt(gas)), wallet(BigInt(gas)), `gas ${gas}`);
  }
  assert.equal(networkFeeForGas(BigInt(216_113)), BigInt(32_417));
});

test("encodes bytes as standard base64", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("reads the sequence from base and nested auth account responses", () => {
  assert.equal(findAccountSequence({ account: { address: sender, account_number: "4", sequence: "60976" } }), BigInt(60976));
  assert.equal(findAccountSequence({ account: { base_account: { address: sender, sequence: "3" }, code_hash: "0x" } }), BigInt(3));
  assert.equal(findAccountSequence({ account: { code_hash: "0x" } }), null);
});

type Route = (url: string, init?: RequestInit) => Response;

async function withFetch<T>(route: Route, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function diana(options: { account?: boolean; pqc?: boolean; simulate: () => Response }): Route {
  return (url) => {
    if (url.includes("/cosmos/auth/v1beta1/accounts/")) {
      return options.account === false
        ? new Response("{}", { status: 404 })
        : Response.json({ account: { address: sender, account_number: "4", sequence: "9" } });
    }
    if (url.includes("/qorechain/pqc/v1/account/")) return Response.json({ found: options.pqc ?? true });
    if (url.endsWith("/cosmos/tx/v1beta1/simulate")) return options.simulate();
    throw new Error(`unexpected ${url}`);
  };
}

test("prepares a signAndBroadcast request from simulated gas", async () => {
  const encoded = encodeAsAny([bank.send({ fromAddress: sender, toAddress: sender, amount: [{ denom: "uqor", amount: "1" }] })]);
  let simulatedBody = "";
  const outcome = await withFetch((url, init) => {
    if (url.endsWith("/simulate")) simulatedBody = String(init?.body ?? "");
    return diana({ pqc: false, simulate: () => Response.json({ gas_info: { gas_used: "89318" } }) })(url, init);
  }, () => prepareWalletTx({ address: sender, chainId: "qorechain-diana", encoded, memo: "probe" }));

  assert.ok(outcome.ok);
  assert.deepEqual(outcome.prepared, {
    chainId: "qorechain-diana",
    messages: toWalletMessages(encoded),
    memo: "probe",
    gasLimit: "216113",
    fee: { amount: "32417", denom: "uqor" },
    pqcKeyRegistered: false,
    simulated: {},
  });
  // The simulation uses the account's current sequence.
  const raw = TxRaw.decode(fromBase64(JSON.parse(simulatedBody).tx_bytes));
  assert.equal(AuthInfo.decode(raw.authInfoBytes).signerInfos[0].sequence, BigInt(9));
});

test("explains unfunded wallets and failing simulations before the wallet opens", async () => {
  const encoded = encodeAsAny([swapMessage]);
  const unfunded = await withFetch(diana({ account: false, simulate: () => Response.json({}) }), () => prepareWalletTx({ address: sender, chainId: "qorechain-diana", encoded }));
  assert.deepEqual(unfunded, { ok: false, reason: "unfunded" });

  const original = console.warn;
  console.warn = () => {};
  try {
    const missingPool = await withFetch(
      diana({ simulate: () => Response.json({ code: 2, message: "failed to execute message; message index: 0: pool not found" }, { status: 400 }) }),
      () => prepareWalletTx({ address: sender, chainId: "qorechain-diana", encoded }),
    );
    assert.deepEqual(missingPool, { ok: false, reason: "simulation", failure: "pool_not_found" });
  } finally {
    console.warn = original;
  }
});

test("detects whether QoreX can build and broadcast native transactions", () => {
  const base = { enable: async () => {}, getKey: async () => ({ bech32Address: sender, pubKey: [] }) };
  assert.equal(qorexSupport(undefined).state, "missing");
  assert.equal(qorexSupport({ ...base, capabilities: ["listAccounts"] }).state, "outdated");
  assert.equal(qorexSupport({ ...base, capabilities: ["signAndBroadcast"] }).state, "outdated");
  assert.equal(qorexSupport({ ...base, capabilities: ["signAndBroadcast"], signAndBroadcast: async () => ({ txHash: "", code: 0 }) }).state, "ready");
});

test("maps QoreX 0.3.5 errors to controlled copy without leaking wallet text", () => {
  const network = walletFailure(new Error("QoreX: chain qorechain-diana does not match the active network qorechain-vladi"));
  assert.equal(network.kind, "network");
  assert.equal(network.copy, QOREX_NETWORK_COPY);
  assert.equal(walletFailure(new Error("QoreX: signature rejected")).kind, "declined");
  assert.equal(walletFailure(new Error("QoreX: wallet is locked")).kind, "locked");
  assert.equal(walletFailure(new Error("Refusing to sign: this action is for qor1a, but the wallet derived qor1b.")).kind, "account");

  const refused = walletFailure(new Error("Transaction rejected by the network (sdk 5): spendable balance 0uqor is smaller than 1uqor: insufficient funds"));
  assert.deepEqual({ kind: refused.kind, codespace: refused.codespace, code: refused.code }, { kind: "chain", codespace: "sdk", code: 5 });
  assert.doesNotMatch(refused.copy, /spendable|qor1/);

  const failed = walletFailure(new Error("Transaction failed on-chain (code 11)."));
  assert.deepEqual({ kind: failed.kind, code: failed.code }, { kind: "onchain", code: 11 });
  assert.match(failed.copy, /ran out of network gas/);

  const unknown = walletFailure(new Error("QoreX: something new at qor1secret"));
  assert.equal(unknown.kind, "other");
  for (const failure of [network, refused, failed, unknown]) assert.doesNotMatch(failure.copy, /—/);
});

test("explains a refused post-quantum layer and on-chain failures without a code", () => {
  const pqc = walletFailure(new Error("Transaction rejected by the network (pqc 4): hybrid signature verification failed"));
  assert.deepEqual({ kind: pqc.kind, codespace: pqc.codespace, code: pqc.code }, { kind: "chain", codespace: "pqc", code: 4 });
  assert.match(pqc.copy, /did not accept QoreX's quantum-safe signature \(pqc code 4\)/);
  assert.doesNotMatch(pqc.copy, /requires/);

  const noCode = walletFailure(new Error("Transaction failed on-chain."));
  assert.equal(noCode.kind, "onchain");
  assert.equal(noCode.code, undefined);

  assert.notEqual(walletFailure(new Error("QoreX: keep the wallet unlocked while waiting")).kind, "locked");
});

/** Shape of a real Diana simulate response (MsgSend, 2026-10-15), trimmed, plus the AMM swap event the keeper emits. */
const SIMULATE_BODY = {
  gas_info: { gas_wanted: "18446744073709551615", gas_used: "88516" },
  result: {
    events: [
      { type: "tx", attributes: [{ key: "fee", value: "30000uqor", index: false }] },
      { type: "message", attributes: [{ key: "action", value: "/cosmos.bank.v1beta1.MsgSend", index: false }, { key: "msg_index", value: "0", index: false }] },
      { type: "transfer", attributes: [{ key: "recipient", value: "qor1treasury", index: false }, { key: "sender", value: sender, index: false }, { key: "amount", value: "10000uqor", index: false }, { key: "msg_index", value: "0", index: false }] },
      { type: "amm_swap", attributes: [
        { key: "pool_id", value: "1" }, { key: "sender", value: sender }, { key: "amount_in", value: "9990000" }, { key: "amount_out", value: "24654515" },
        { key: "denom_in", value: "uqor" }, { key: "denom_out", value: "utest" }, { key: "fee_bps", value: "30" }, { key: "protocol_fee", value: "9990" },
        { key: "reserve_a", value: "1009990000" }, { key: "reserve_b", value: "2475345485" }, { key: "msg_index", value: "1" },
      ] },
    ],
  },
};

test("reads the keeper's swap result from simulation events", () => {
  const events = parseSimulationEvents(SIMULATE_BODY);
  assert.equal(events.length, 4);
  assert.deepEqual(simulatedOutcome(events).swap, { amountIn: "9990000", denomIn: "uqor", amountOut: "24654515", denomOut: "utest" });
  assert.deepEqual(simulatedOutcome([]), {});
  assert.deepEqual(parseSimulationEvents(null), []);
});

test("reads base64 event attributes from older nodes", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const events = parseSimulationEvents({ result: { events: [{ type: "amm_liquidity_added", attributes: [
    { key: b64("pool_id"), value: b64("1") }, { key: b64("lp_minted"), value: b64("158113883") }, { key: b64("tokens_in"), value: b64("100000000uqor,250000000utest") }, { key: b64("msg_index"), value: b64("0") },
  ] }] } });
  const outcome = simulatedOutcome(events);
  assert.equal(outcome.lpMinted, "158113883");
  assert.deepEqual(outcome.tokensIn, [{ amount: "100000000", denom: "uqor" }, { amount: "250000000", denom: "utest" }]);
  assert.deepEqual(parseCoins("5ibc/ABC, junk ,7uqor"), [{ amount: "5", denom: "ibc/ABC" }, { amount: "7", denom: "uqor" }]);
});

test("adds up everything a transaction takes from the balance", () => {
  const swapWithFee = encodeAsAny([
    bank.send({ fromAddress: sender, toAddress: "qor1treasuryaddress0000000000000", amount: [{ denom: "uqor", amount: "10000" }] }),
    amm.swapExactIn({ sender, poolId: "1", tokenIn: { denom: "uqor", amount: "9990000" }, denomOut: "utest", minOut: "24531242" }),
  ]);
  assert.deepEqual([...requiredSpend(swapWithFee)], [["uqor", BigInt(10_000_000)]]);

  const create = encodeAsAny([amm.createPool({ creator: sender, poolType: "constant_product", initialDepositA: { denom: "uqor", amount: "1000000000" }, initialDepositB: { denom: "utest", amount: "2500000000" }, amplificationCoefficient: 0 })]);
  assert.deepEqual([...requiredSpend(create, { poolCreationFee: BigInt(100_000_000) })], [["uqor", BigInt(1_100_000_000)], ["utest", BigInt(2_500_000_000)]]);

  const remove = encodeAsAny([amm.removeLiquidity({ sender, poolId: "1", lpAmount: "5", minAmountA: "1", minAmountB: "1" })]);
  assert.equal(requiredSpend(remove).size, 0);
});

test("names the exact reason a balance falls short", () => {
  const spend = new Map([["uqor", BigInt(1_100_000_000)], ["utest", BigInt(2_500_000_000)]]);
  const fee = BigInt(45_000);
  const options = { poolCreationFee: BigInt(100_000_000) };
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(1_100_045_000)], ["utest", BigInt(2_500_000_000)]]), fee, options), null);
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(1_100_044_999)], ["utest", BigInt(2_500_000_000)]]), fee, options), "network_fee");
  // Deposits fit, the 100 QOR creation fee does not.
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(1_050_000_000)], ["utest", BigInt(2_500_000_000)]]), fee, options), "pool_creation_fee");
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(900_000_000)], ["utest", BigInt(2_500_000_000)]]), fee, options), "insufficient_funds");
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(2_000_000_000)]]), fee, options), "insufficient_funds");
});

test("refuses before the wallet opens when the network fee does not fit", async () => {
  const encoded = encodeAsAny([amm.swapExactIn({ sender, poolId: "1", tokenIn: { denom: "uqor", amount: "1000000" }, denomOut: "utest", minOut: "1" })]);
  const simulate = () => Response.json(SIMULATE_BODY);
  // 1,000,000 uqor spend + 32,417 uqor network fee for 88,516 simulated gas.
  const short = await withFetch(diana({ simulate }), () => prepareWalletTx({ address: sender, chainId: "qorechain-diana", encoded, balanceCheck: { readBalances: async () => new Map([["uqor", BigInt(1_020_000)]]) } }));
  assert.deepEqual(short, { ok: false, reason: "simulation", failure: "network_fee" });
  const enough = await withFetch(diana({ simulate }), () => prepareWalletTx({ address: sender, chainId: "qorechain-diana", encoded, balanceCheck: { readBalances: async () => new Map([["uqor", BigInt(1_032_417)]]) } }));
  assert.ok(enough.ok);
  assert.equal(enough.prepared.simulated.swap?.amountOut, "24654515");
});

test("maps keeper errors from x/amm/types/errors.go to fixed reasons and copy", () => {
  assert.equal(classifySimulationError("failed to execute message; message index: 0: deposit below minimum liquidity"), "below_min_liquidity");
  assert.equal(classifySimulationError("failed to execute message; message index: 0: pool already exists for this token pair"), "pool_exists");
  assert.equal(classifySimulationError("failed to execute message; message index: 1: pool creator has reached max pools"), "pool_limit");
  assert.equal(classifySimulationError("failed to execute message; message index: 1: slippage tolerance exceeded: price impact 612 bps above max 500"), "impact_too_high");
  assert.equal(classifySimulationError("failed to execute message; message index: 1: slippage tolerance exceeded: got 10 want 11"), "price_moved");
  assert.equal(chainFailureCopy("amm", 7), SIMULATION_FAILURE_COPY.pool_exists);
  assert.equal(chainFailureCopy("amm", 9), SIMULATION_FAILURE_COPY.below_min_liquidity);
  assert.equal(chainFailureCopy("amm", 17), SIMULATION_FAILURE_COPY.pool_limit);
  assert.equal(chainFailureCopy("amm", 3), SIMULATION_FAILURE_COPY.insufficient_liquidity);
  for (const copy of [...Object.values(SIMULATION_FAILURE_COPY), ...Object.values(QUOTE_FAILURE_COPY), ...Object.values(QUOTE_BLOCK_COPY)]) {
    assert.doesNotMatch(copy, /—/);
  }
});
