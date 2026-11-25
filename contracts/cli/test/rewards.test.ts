import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { qorechainRegistry } from "@qorechain/sdk";
import { MsgResetCircuitBreaker, MsgTripCircuitBreaker } from "cosmjs-types/cosmos/circuit/v1/tx";
import { MsgExecuteContract, MsgInstantiateContract, MsgStoreCode } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { AccessType } from "cosmjs-types/cosmwasm/wasm/v1/types";
import { GOV_MODULE_ADDRESS, TOKEN_REGISTRY_TYPES } from "../src/qwakk-token.ts";
import {
  REWARDS_REGISTRY_TYPES,
  checkStageAgainstContract,
  claimMsg,
  compareWithReference,
  gzipWasm,
  instantiateMsg,
  parseStageFile,
  registerStageBody,
  registerStageMsg,
  sha256Hex,
  storeCodeProposalMsg,
  storeCodeProposalShape,
} from "../src/rewards-lib.ts";

const DEPLOYER = "qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp";
const OWNER = "qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq";
const CONTRACT = "qor1xjayq5ev55tkzpml9klxwyshr7gdrha0nurha9jhm0f0gdckksgs3gltw8";
const QWAKK = "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";
const wasmUrl = new URL("../../rewards/artifacts/qwakk_rewards.wasm", import.meta.url);
/** A minimal valid wasm module, for when the optimized artifact is not built. */
const TINY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/**
 * A stage file exactly as the indexer writes it: `npm run rewards -- finalize
 * ... --out stage.json` (indexer/rewards-config.ts `stageJson`).
 */
const INDEXER_STAGE_FILE = `{
  "stage_id": 1,
  "root": "a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac",
  "total": "3500007",
  "denom": "${QWAKK}",
  "pool_id": 6,
  "start": 1796083200,
  "end": 1798675200,
  "label": "QWAKK/QOR LP rewards, epoch 1 (2026-11-27 to 2026-12-04)"
}
`;

test("reads the indexer's stage file as it is", () => {
  const stage = parseStageFile(INDEXER_STAGE_FILE);
  assert.deepEqual(stage, {
    stageId: 1n,
    merkleRoot: "a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac",
    total: 3_500_007n,
    denom: QWAKK,
    poolId: 6n,
    start: 1_796_083_200n,
    end: 1_798_675_200n,
    label: "QWAKK/QOR LP rewards, epoch 1 (2026-11-27 to 2026-12-04)",
  });
  // merkle_root is accepted too, and upper-case hex is normalised.
  const alias = JSON.parse(INDEXER_STAGE_FILE);
  alias.merkle_root = alias.root.toUpperCase();
  delete alias.root;
  assert.equal(parseStageFile(JSON.stringify(alias)).merkleRoot, stage.merkleRoot);
});

test("the register_stage body matches the contract's ExecuteMsg and carries exactly the total", () => {
  const stage = parseStageFile(INDEXER_STAGE_FILE);
  const body = registerStageBody(stage);
  assert.equal(
    body,
    `{"register_stage":{"denom":"${QWAKK}","merkle_root":"a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac","total":"3500007","start":1796083200,"end":1798675200,"pool_id":6,"label":"QWAKK/QOR LP rewards, epoch 1 (2026-11-27 to 2026-12-04)"}}`,
  );
  assert.deepEqual(JSON.parse(body).register_stage.total, "3500007");
  const msg = registerStageMsg({ sender: DEPLOYER, contract: CONTRACT, stage });
  assert.deepEqual(msg.value.funds, [{ denom: QWAKK, amount: "3500007" }]);
  assert.equal(new TextDecoder().decode(msg.value.msg), body);
  // Encodes through the registry the CLI signs with.
  const any = qorechainRegistry([...TOKEN_REGISTRY_TYPES, ...REWARDS_REGISTRY_TYPES]).encodeAsAny(msg);
  assert.equal(MsgExecuteContract.decode(any.value).contract, CONTRACT);
  // A label with quotes stays valid JSON.
  assert.equal(JSON.parse(registerStageBody({ ...stage, label: 'a "b" \\ c' })).register_stage.label, 'a "b" \\ c');
});

test("refuses broken stage files", () => {
  const base = JSON.parse(INDEXER_STAGE_FILE);
  const bad: Array<[string, Record<string, unknown>]> = [
    ["short root", { root: "abcd" }],
    ["root and merkle_root differ", { merkle_root: "00".repeat(32) }],
    ["stage 0", { stage_id: 0 }],
    ["fractional total", { total: "1.5" }],
    ["zero total", { total: "0" }],
    ["total too big", { total: (1n << 128n).toString() }],
    ["no denom", { denom: "" }],
    ["end before start", { end: 1796083200 }],
    ["unsafe number", { start: 2 ** 60 }],
    ["long label", { label: "x".repeat(129) }],
  ];
  for (const [label, patch] of bad) assert.throws(() => parseStageFile(JSON.stringify({ ...base, ...patch })), Error, label);
  assert.throws(() => parseStageFile("not json"));
});

test("a stage file only registers as the contract's next stage, while its window is open", () => {
  const stage = parseStageFile(INDEXER_STAGE_FILE);
  checkStageAgainstContract(stage, { stageCount: 0n, nowSeconds: 1_796_000_000n });
  assert.throws(() => checkStageAgainstContract(stage, { stageCount: 1n, nowSeconds: 1_796_000_000n }), /next stage is 2/);
  assert.throws(() => checkStageAgainstContract(stage, { stageCount: 0n, nowSeconds: 1_798_675_200n }), /already ended/);
});

test("the store-code proposal is proposal 40's three messages, signed by gov, with permission Everybody", () => {
  const wasm = existsSync(wasmUrl) ? new Uint8Array(readFileSync(wasmUrl)) : TINY_WASM;
  const msg = storeCodeProposalMsg({ wasm, version: "0.1.0", proposer: DEPLOYER, depositUqor: 50_000_000n, expedited: true });
  assert.equal(msg.typeUrl, "/cosmos.gov.v1.MsgSubmitProposal");
  assert.equal(msg.value.expedited, true);
  assert.deepEqual(msg.value.initialDeposit, [{ denom: "uqor", amount: "50000000" }]);
  assert.equal(msg.value.proposer, DEPLOYER);
  assert.equal(msg.value.metadata, "");
  assert.ok(msg.value.summary.includes(sha256Hex(wasm)));
  assert.ok(!/\u2014/.test(msg.value.title + msg.value.summary), "no em dashes");
  assert.deepEqual(msg.value.messages.map((m) => m.typeUrl), ["/cosmos.circuit.v1.MsgResetCircuitBreaker", "/cosmwasm.wasm.v1.MsgStoreCode", "/cosmos.circuit.v1.MsgTripCircuitBreaker"]);
  const reset = MsgResetCircuitBreaker.decode(msg.value.messages[0].value);
  const trip = MsgTripCircuitBreaker.decode(msg.value.messages[2].value);
  for (const b of [reset, trip]) assert.deepEqual({ authority: b.authority, urls: b.msgTypeUrls }, { authority: GOV_MODULE_ADDRESS, urls: ["/cosmwasm.wasm.v1.MsgStoreCode"] });
  const store = MsgStoreCode.decode(msg.value.messages[1].value);
  assert.equal(store.sender, GOV_MODULE_ADDRESS);
  assert.equal(store.instantiatePermission?.permission, AccessType.ACCESS_TYPE_EVERYBODY);
  assert.deepEqual(store.instantiatePermission?.addresses, []);
  // The gzip unpacks to exactly the checksummed wasm, and is deterministic.
  assert.equal(sha256Hex(new Uint8Array(gunzipSync(store.wasmByteCode))), sha256Hex(wasm));
  assert.deepEqual(gzipWasm(wasm), store.wasmByteCode);
  // The whole proposal encodes through the CLI's registry.
  const any = qorechainRegistry([...TOKEN_REGISTRY_TYPES, ...REWARDS_REGISTRY_TYPES]).encodeAsAny(msg);
  assert.ok(any.value.length > store.wasmByteCode.length);
  assert.equal(storeCodeProposalMsg({ wasm, version: "0.1.0", proposer: DEPLOYER, depositUqor: 10_000_000n, expedited: false }).value.expedited, false);
  assert.throws(() => gzipWasm(Uint8Array.from([1, 2, 3, 4])));
});

test("structure comparison with Diana proposal 40 ignores only the code", () => {
  const gz = gzipWasm(TINY_WASM);
  // Proposal 40's first three messages as /cosmos/gov/v1/proposals/40 returned them on 2026-11-25 (code shortened).
  const proposal40 = [
    { "@type": "/cosmos.circuit.v1.MsgResetCircuitBreaker", authority: GOV_MODULE_ADDRESS, msg_type_urls: ["/cosmwasm.wasm.v1.MsgStoreCode"] },
    { "@type": "/cosmwasm.wasm.v1.MsgStoreCode", sender: GOV_MODULE_ADDRESS, wasm_byte_code: "H4sIAAAA...", instantiate_permission: { permission: "Everybody", addresses: [] } },
    { "@type": "/cosmos.circuit.v1.MsgTripCircuitBreaker", authority: GOV_MODULE_ADDRESS, msg_type_urls: ["/cosmwasm.wasm.v1.MsgStoreCode"] },
  ];
  assert.deepEqual(compareWithReference(storeCodeProposalShape(gz), proposal40), []);
  const changed = structuredClone(proposal40);
  changed[1].instantiate_permission = { permission: "Nobody", addresses: [] };
  assert.equal(compareWithReference(storeCodeProposalShape(gz), changed).length, 1);
});

test("instantiate defaults the wasm admin to the owner, and admin can be none", () => {
  const msg = instantiateMsg({ sender: DEPLOYER, codeId: 870n, owner: OWNER });
  assert.equal(msg.value.admin, OWNER);
  assert.equal(new TextDecoder().decode(msg.value.msg), `{"owner":"${OWNER}"}`);
  assert.deepEqual(msg.value.funds, []);
  assert.equal(instantiateMsg({ sender: DEPLOYER, codeId: 870n, owner: OWNER, admin: "" }).value.admin, "");
  assert.equal(instantiateMsg({ sender: DEPLOYER, codeId: 870n, owner: OWNER, admin: DEPLOYER }).value.admin, DEPLOYER);
  assert.throws(() => instantiateMsg({ sender: DEPLOYER, codeId: 0n, owner: OWNER }));
  assert.throws(() => instantiateMsg({ sender: DEPLOYER, codeId: 1n, owner: "qor1nope" }));
  assert.equal(MsgInstantiateContract.decode(qorechainRegistry([...REWARDS_REGISTRY_TYPES]).encodeAsAny(msg).value).codeId, 870n);
});

test("claim has no funds and the app's exact body", () => {
  const proof = ["DCD131A3554DF512903BE2CD0DADDD866AB1191774935BA7CA76D9A7F0CED676"];
  const msg = claimMsg({ sender: DEPLOYER, contract: CONTRACT, stageId: 1n, amount: 2_500_000n, proof });
  assert.deepEqual(msg.value.funds, []);
  assert.equal(new TextDecoder().decode(msg.value.msg), `{"claim":{"stage_id":1,"amount":"2500000","proof":["${proof[0].toLowerCase()}"]}}`);
  assert.throws(() => claimMsg({ sender: DEPLOYER, contract: CONTRACT, stageId: 1n, amount: 1n, proof: ["xyz"] }));
});
