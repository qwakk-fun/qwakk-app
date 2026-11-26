import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amm, bank, isValidBech32 } from "@qorechain/sdk";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";

import { parseNativeActionSwitches } from "../lib/features";
import { encodedMessagesForAction, interfaceFeeInMessages, parseNativeAction } from "../lib/qwakk-native-actions";
import {
  MAX_REWARDS_PROOF_LENGTH,
  WASM_EXECUTE_TYPE,
  buildRewardsClaimMessage,
  checkRewardsClaim,
  isAllowedRewardsClaim,
  resolveRewardsContract,
  rewardsClaimAction,
  rewardsClaimMsgJson,
  rewardsLeafHex,
  verifyRewardsProof,
} from "../lib/qwakk-native-rewards";
import { balanceShortfall, classifySimulationError, encodeAsAny, isAllowedMessageSet, requiredSpend, toWalletMessages } from "../lib/qwakk-native-tx";
import { SIMULATION_FAILURE_COPY, chainFailureCopy } from "../lib/qwakk-tx-copy";

/** The shared test vector, also asserted by the contract (contracts/rewards/tests/integration.rs) and made by testdata/vector.py. */
type Vector = { stage: number; root: string; claims: Array<{ address: string; amount: string; leaf: string; proof: string[] }> };
const vector = JSON.parse(readFileSync(new URL("../contracts/rewards/testdata/vector.json", import.meta.url), "utf8")) as Vector;

const SENDER = "qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp";
const TREASURY = "qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq";
/** A real 32-byte contract address on QoreChain Diana (code 865, proposal 40). */
const CONTRACT = "qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8";
const OTHER_CONTRACT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const FEE_OFF = { enabled: false, feeBps: 10 } as const;
const claim = { stageId: "1", amount: vector.claims[1].amount, proof: vector.claims[1].proof };

function executeAny(body: string, overrides: Partial<{ sender: string; contract: string; funds: Array<{ denom: string; amount: string }> }> = {}) {
  return {
    typeUrl: WASM_EXECUTE_TYPE,
    value: MsgExecuteContract.encode(MsgExecuteContract.fromPartial({ sender: SENDER, contract: CONTRACT, msg: new TextEncoder().encode(body), funds: [], ...overrides })).finish(),
  };
}

test("the test addresses are valid qor1 bech32", () => {
  for (const address of [SENDER, TREASURY, CONTRACT, OTHER_CONTRACT]) assert.equal(isValidBech32(address, "qor"), true, address);
});

test("leaves and proofs match the shared vector (contract encoding)", () => {
  assert.equal(vector.root, "a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac");
  for (const entry of vector.claims) {
    assert.equal(rewardsLeafHex(String(vector.stage), entry.address, entry.amount), entry.leaf);
    assert.equal(verifyRewardsProof({ stageId: String(vector.stage), address: entry.address, amount: entry.amount, proof: entry.proof, root: vector.root }), true);
    // Upper-case hex is the same proof.
    assert.equal(verifyRewardsProof({ stageId: "1", address: entry.address, amount: entry.amount, proof: entry.proof.map((p) => p.toUpperCase()), root: vector.root.toUpperCase() }), true);
    // Bound to the amount, the stage id, the address and the root.
    assert.equal(verifyRewardsProof({ stageId: "1", address: entry.address, amount: (BigInt(entry.amount) + BigInt(1)).toString(), proof: entry.proof, root: vector.root }), false);
    assert.equal(verifyRewardsProof({ stageId: "2", address: entry.address, amount: entry.amount, proof: entry.proof, root: vector.root }), false);
    assert.equal(verifyRewardsProof({ stageId: "1", address: OTHER_CONTRACT, amount: entry.amount, proof: entry.proof, root: vector.root }), false);
    assert.equal(verifyRewardsProof({ stageId: "1", address: entry.address, amount: entry.amount, proof: entry.proof, root: "00".repeat(32) }), false);
  }
  assert.equal(verifyRewardsProof({ stageId: "1", address: SENDER, amount: "2500000", proof: ["zz"], root: vector.root }), false);
});

test("a claim is exactly one MsgExecuteContract with the claim body and no funds", () => {
  const message = buildRewardsClaimMessage({ sender: SENDER, contract: CONTRACT, ...claim });
  assert.equal(message.typeUrl, "/cosmwasm.wasm.v1.MsgExecuteContract");
  const decoded = MsgExecuteContract.decode(message.value);
  assert.equal(decoded.sender, SENDER);
  assert.equal(decoded.contract, CONTRACT);
  assert.deepEqual(decoded.funds, []);
  assert.equal(
    new TextDecoder().decode(decoded.msg),
    `{"claim":{"stage_id":1,"amount":"2500000","proof":["${vector.claims[1].proof[0]}","${vector.claims[1].proof[1]}"]}}`,
  );
  // The wallet payload is base64 protobuf, like every other action.
  const [wallet] = toWalletMessages([message]);
  assert.equal(wallet.typeUrl, WASM_EXECUTE_TYPE);
  assert.deepEqual(MsgExecuteContract.decode(Uint8Array.from(Buffer.from(wallet.value, "base64"))).msg, decoded.msg);
});

test("claim fields are validated and canonicalised, u64 stage ids survive exactly", () => {
  assert.equal(rewardsClaimMsgJson({ stageId: "18446744073709551615", amount: "340282366920938463463374607431768211455", proof: [] }), `{"claim":{"stage_id":18446744073709551615,"amount":"340282366920938463463374607431768211455","proof":[]}}`);
  assert.deepEqual(checkRewardsClaim({ stageId: "007", amount: "0100", proof: ["AB".repeat(32)] }), { stageId: "7", amount: "100", proof: ["ab".repeat(32)] });
  const bad: Array<[string, Parameters<typeof checkRewardsClaim>[0]]> = [
    ["stage 0", { stageId: "0", amount: "1", proof: [] }],
    ["stage over u64", { stageId: "18446744073709551616", amount: "1", proof: [] }],
    ["stage not a number", { stageId: "1e3", amount: "1", proof: [] }],
    ["negative stage", { stageId: "-1", amount: "1", proof: [] }],
    ["amount 0", { stageId: "1", amount: "0", proof: [] }],
    ["amount over u128", { stageId: "1", amount: "340282366920938463463374607431768211456", proof: [] }],
    ["decimal amount", { stageId: "1", amount: "1.5", proof: [] }],
    ["short hash", { stageId: "1", amount: "1", proof: ["ab"] }],
    ["quote in proof", { stageId: "1", amount: "1", proof: [`${"a".repeat(63)}"`] }],
    ["proof too long", { stageId: "1", amount: "1", proof: Array(MAX_REWARDS_PROOF_LENGTH + 1).fill("a".repeat(64)) }],
  ];
  for (const [label, input] of bad) assert.throws(() => checkRewardsClaim(input), Error, label);
  assert.throws(() => buildRewardsClaimMessage({ sender: "qor1notvalid", contract: CONTRACT, ...claim }));
  assert.throws(() => buildRewardsClaimMessage({ sender: SENDER, contract: `${CONTRACT.slice(0, -1)}q`, ...claim }));
});

test("the relay allows a claim only to the configured contract, alone, from the sender, without funds", () => {
  const good = buildRewardsClaimMessage({ sender: SENDER, contract: CONTRACT, ...claim });
  assert.equal(isAllowedMessageSet([good], SENDER, undefined, CONTRACT), true);
  assert.equal(isAllowedMessageSet([good], SENDER, TREASURY, CONTRACT), true);
  // Claims off, another contract, another sender.
  assert.equal(isAllowedMessageSet([good], SENDER), false);
  assert.equal(isAllowedMessageSet([good], SENDER, undefined, null), false);
  assert.equal(isAllowedMessageSet([good], SENDER, undefined, OTHER_CONTRACT), false);
  assert.equal(isAllowedMessageSet([good], TREASURY, undefined, CONTRACT), false);
  // Never next to anything else, never twice.
  const swap = encodeAsAny([amm.swapExactIn({ sender: SENDER, poolId: "1", tokenIn: { denom: "uqor", amount: "10" }, denomOut: "utest", minOut: "1" })])[0];
  const send = encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: TREASURY, amount: [{ denom: "uqor", amount: "1" }] })])[0];
  assert.equal(isAllowedMessageSet([good, swap], SENDER, undefined, CONTRACT), false);
  assert.equal(isAllowedMessageSet([swap, good], SENDER, TREASURY, CONTRACT), false);
  assert.equal(isAllowedMessageSet([good, send], SENDER, TREASURY, CONTRACT), false);
  assert.equal(isAllowedMessageSet([good, good], SENDER, undefined, CONTRACT), false);
  // Funds attached.
  const body = rewardsClaimMsgJson(claim);
  assert.equal(isAllowedRewardsClaim([executeAny(body)], SENDER, CONTRACT), true);
  assert.equal(isAllowedRewardsClaim([executeAny(body, { funds: [{ denom: "uqor", amount: "1" }] })], SENDER, CONTRACT), false);
  // Any other contract call, or a claim body that is not canonical.
  for (const other of [
    `{"register_stage":{"denom":"uqor","merkle_root":"${"0".repeat(64)}","total":"1","start":1,"end":2,"pool_id":1,"label":""}}`,
    `{"reclaim":{"stage_id":1}}`,
    `{"accept_owner":{}}`,
    `{"claim":{"stage_id":1,"amount":"2500000","proof":[],"extra":1}}`,
    `{"claim":{"stage_id":"1","amount":"2500000","proof":[]}}`,
    `{"claim":{"stage_id":1,"amount":2500000,"proof":[]}}`,
    `{"claim":{"stage_id":1, "amount":"2500000","proof":[]}}`,
    `{"claim":{"stage_id":1,"amount":"2500000","proof":[]},"reclaim":{"stage_id":1}}`,
    `{"claim":{"stage_id":0,"amount":"2500000","proof":[]}}`,
    `[{"claim":{}}]`,
    "not json",
  ]) assert.equal(isAllowedRewardsClaim([executeAny(other)], SENDER, CONTRACT), false, other);
  // Undecodable bytes.
  assert.equal(isAllowedRewardsClaim([{ typeUrl: WASM_EXECUTE_TYPE, value: Uint8Array.from([0xff, 0xff, 0xff]) }], SENDER, CONTRACT), false);
});

test("the action parses from JSON and builds through the shared action path", () => {
  for (const kind of ["rewards_claim", "rewards-claim"]) {
    const action = parseNativeAction({ kind, stageId: 1, amount: " 2500000 ", proof: vector.claims[1].proof.map((p) => p.toUpperCase()) });
    assert.deepEqual(action, { kind: "rewards_claim", stageId: "1", amount: "2500000", proof: vector.claims[1].proof });
    const encoded = encodedMessagesForAction(SENDER, action, FEE_OFF, CONTRACT);
    assert.equal(encoded.length, 1);
    assert.equal(isAllowedMessageSet(encoded, SENDER, undefined, CONTRACT), true);
    assert.equal(interfaceFeeInMessages(encoded), null);
    assert.throws(() => encodedMessagesForAction(SENDER, action, FEE_OFF, null), /not available/);
  }
  // A claim action never carries the interface fee, even when the fee is on.
  const encoded = encodedMessagesForAction(SENDER, rewardsClaimAction(claim), { enabled: true, recipient: TREASURY, feeBps: 10 }, CONTRACT);
  assert.deepEqual(encoded.map((m) => m.typeUrl), [WASM_EXECUTE_TYPE]);
  assert.throws(() => encodedMessagesForAction(SENDER, { kind: "rewards_claim", stageId: "1", amount: "0", proof: [] }, FEE_OFF, CONTRACT));
});

test("the UI helper turns an indexer claim into the action", () => {
  assert.deepEqual(rewardsClaimAction({ stageId: 3, amount: "7", proof: ["a".repeat(64)] }), { kind: "rewards_claim", stageId: "3", amount: "7", proof: ["a".repeat(64)] });
});

test("a claim spends nothing but the network fee", () => {
  const encoded = [buildRewardsClaimMessage({ sender: SENDER, contract: CONTRACT, ...claim })];
  const spend = requiredSpend(encoded);
  assert.equal(spend.size, 0);
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(100)]]), BigInt(100)), null);
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(99)]]), BigInt(100)), "network_fee");
});

test("contract refusals map to fixed rewards copy", () => {
  // The exact texts a local wasmd v0.60.2 node returned for the optimized contract (rehearsal 2026-11-25).
  const wrap = (reason: string) => `failed to execute message; message index: 0: qwakk-rewards: ${reason}: execute wasm contract failed [CosmWasm/wasmd/x/wasm/keeper/keeper.go:436] With gas wanted: '18446744073709551615' and gas used: '138164' : unknown request`;
  const cases: Array<[string, string]> = [
    ["already claimed", "rewards_claimed"],
    ["invalid proof", "rewards_invalid"],
    ["amount must be positive", "rewards_invalid"],
    ["claim window not open", "rewards_not_open"],
    ["claim window ended", "rewards_ended"],
    ["stage closed", "rewards_ended"],
    ["stage paused", "rewards_paused"],
    ["stage total exceeded", "rewards_exhausted"],
    ["stage not found", "rewards_unavailable"],
    ["no funds may be attached", "rejected"],
    ["unauthorized", "rejected"],
  ];
  for (const [reason, failure] of cases) assert.equal(classifySimulationError(wrap(reason)), failure, reason);
  // AMM texts still map as before.
  assert.equal(classifySimulationError("pool not found"), "pool_not_found");
  for (const key of ["rewards_claimed", "rewards_invalid", "rewards_not_open", "rewards_ended", "rewards_paused", "rewards_exhausted", "rewards_unavailable"] as const) {
    const copy = SIMULATION_FAILURE_COPY[key];
    assert.ok(copy.length > 10 && !copy.includes("\u2014") && !copy.includes("qwakk-rewards"), key);
  }
  assert.ok(!chainFailureCopy("wasm", 5).includes("\u2014"));
  assert.notEqual(chainFailureCopy("wasm", 5), chainFailureCopy("wasm", 4));
});

test("the rewards contract is configured per network and fails closed", () => {
  assert.deepEqual(resolveRewardsContract({}, "testnet"), { contract: null, warning: null });
  assert.deepEqual(resolveRewardsContract({ QWAKK_REWARDS_CONTRACT_ADDRESS: ` ${CONTRACT} ` }, "testnet"), { contract: CONTRACT, warning: null });
  // CosmWasm is open on QoreChain Diana only.
  assert.equal(resolveRewardsContract({ QWAKK_REWARDS_CONTRACT_ADDRESS: CONTRACT }, "mainnet").contract, null);
  for (const bad of ["0x6fEFdEA7209797c116747450b12695AccbE81133", `${CONTRACT.slice(0, -1)}q`, CONTRACT.toUpperCase(), "qor1short"]) {
    const resolved = resolveRewardsContract({ QWAKK_REWARDS_CONTRACT_ADDRESS: bad }, "testnet");
    assert.equal(resolved.contract, null, bad);
    assert.ok(resolved.warning, bad);
  }
});

test("rewards_claim is its own action switch and never part of enabled", () => {
  assert.equal(parseNativeActionSwitches("swap").actions.rewards_claim, false);
  assert.equal(parseNativeActionSwitches("rewards_claim").actions.rewards_claim, true);
  assert.equal(parseNativeActionSwitches("rewards_claim").actions.swap, false);
  assert.equal(parseNativeActionSwitches("enabled").actions.rewards_claim, false);
  assert.equal(parseNativeActionSwitches("all").actions.rewards_claim, false);
  assert.deepEqual(parseNativeActionSwitches("swap,liquidity,create_pool,rewards_claim").actions, { swap: true, add_liquidity: true, remove_liquidity: true, create_pool: true, rewards_claim: true, send: false });
});
