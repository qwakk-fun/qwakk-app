/**
 * Pure builders for the qwakk-rewards CLI (src/rewards.ts): the store-code
 * governance proposal, instantiate, register_stage from the indexer's stage
 * file, and claim. Nothing here reads keys or the network, so it is unit
 * tested (test/rewards.test.ts).
 *
 * The proposal follows QoreChain Diana proposal 40 and the docs
 * (developer-guide/governance-proposals-contracts): reset the MsgStoreCode
 * circuit breaker, MsgStoreCode by the gov module with instantiate permission
 * Everybody, trip the breaker again, all inside one proposal.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { isValidBech32, type qorechainRegistry } from "@qorechain/sdk";
import { MsgResetCircuitBreaker, MsgTripCircuitBreaker } from "cosmjs-types/cosmos/circuit/v1/tx";
import { MsgExecuteContract, MsgInstantiateContract, MsgStoreCode } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { AccessType } from "cosmjs-types/cosmwasm/wasm/v1/types";
import { GOV_MODULE_ADDRESS, MSG_SUBMIT_PROPOSAL_TYPE_URL } from "./qwakk-token.js";

type ExtraTypes = NonNullable<Parameters<typeof qorechainRegistry>[0]>;

export const MSG_STORE_CODE = "/cosmwasm.wasm.v1.MsgStoreCode";
export const MSG_INSTANTIATE = "/cosmwasm.wasm.v1.MsgInstantiateContract";
export const MSG_EXECUTE = "/cosmwasm.wasm.v1.MsgExecuteContract";
export const MSG_RESET_BREAKER = "/cosmos.circuit.v1.MsgResetCircuitBreaker";
export const MSG_TRIP_BREAKER = "/cosmos.circuit.v1.MsgTripCircuitBreaker";

/** Types @qorechain/sdk 0.14.0's registry does not ship, for EthNativeSigner's `registry` option. */
export const REWARDS_REGISTRY_TYPES: ExtraTypes = [
  [MSG_INSTANTIATE, MsgInstantiateContract],
  [MSG_EXECUTE, MsgExecuteContract],
];

/** The optimizer image the checksum in the proposal is reproducible with (docs example uses the same tag). */
export const OPTIMIZER_IMAGE = "cosmwasm/optimizer-arm64:0.16.1";

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function isQorAddress(value: string) {
  return /^qor1[02-9ac-hj-np-z]{38,90}$/.test(value) && isValidBech32(value, "qor");
}

function requireQor(value: string | undefined, name: string): string {
  const v = value?.trim() ?? "";
  if (!isQorAddress(v)) throw new Error(`${name} must be a qor1 address. Nothing was sent.`);
  return v;
}

// ---------------------------------------------------------------------------
// Store-code proposal
// ---------------------------------------------------------------------------

/** gzip with a fixed header (no name, mtime 0), so the same wasm always gives the same proposal bytes. */
export function gzipWasm(wasm: Uint8Array): Uint8Array {
  if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) throw new Error("Not a wasm file.");
  return new Uint8Array(gzipSync(wasm, { level: 9 }));
}

export function storeCodeProposalText(input: { checksum: string; version: string; size: number }) {
  return {
    title: "Testnet: store qwakk-rewards, a Merkle claim contract for Qwakk liquidity rewards",
    summary:
      `Stores qwakk-rewards ${input.version} (sha256 ${input.checksum}, ${input.size} bytes, built reproducibly with ${OPTIMIZER_IMAGE} ` +
      "from contracts/rewards in github.com/qwakk-fun/qwakk-app). It pays weekly liquidity rewards on QoreChain Diana as Merkle claims. " +
      "Each stage is funded with exactly its total when it is registered and pays out at most that total, so stages are isolated from each other. " +
      "Its owner can register, pause and resume stages and reclaim expired ones; it needs only the iterator capability. " +
      "Qwakk will instantiate it with its testnet deployer as wasm admin so a fixed version can be migrated in place; that admin could migrate to other stored code, so on Diana trust in unclaimed rewards rests on that key. " +
      "This proposal stores the code with instantiate permission Everybody and instantiates nothing; Qwakk instantiates it afterwards. " +
      "The MsgStoreCode breaker is reset and tripped again inside this proposal; code upload by accounts stays closed.",
  };
}

/** The three inner messages, in proposal 40's order, as protobuf `Any`s. */
export function storeCodeProposalMessages(gzippedWasm: Uint8Array) {
  const breaker = { authority: GOV_MODULE_ADDRESS, msgTypeUrls: [MSG_STORE_CODE] };
  return [
    { typeUrl: MSG_RESET_BREAKER, value: MsgResetCircuitBreaker.encode(MsgResetCircuitBreaker.fromPartial(breaker)).finish() },
    {
      typeUrl: MSG_STORE_CODE,
      value: MsgStoreCode.encode(
        MsgStoreCode.fromPartial({
          sender: GOV_MODULE_ADDRESS,
          wasmByteCode: gzippedWasm,
          instantiatePermission: { permission: AccessType.ACCESS_TYPE_EVERYBODY, addresses: [] },
        }),
      ).finish(),
    },
    { typeUrl: MSG_TRIP_BREAKER, value: MsgTripCircuitBreaker.encode(MsgTripCircuitBreaker.fromPartial(breaker)).finish() },
  ];
}

export function storeCodeProposalMsg(input: { wasm: Uint8Array; version: string; proposer: string; depositUqor: bigint; expedited: boolean }) {
  if (input.depositUqor <= 0n) throw new Error("the deposit must be positive");
  const gz = gzipWasm(input.wasm);
  const text = storeCodeProposalText({ checksum: sha256Hex(input.wasm), version: input.version, size: input.wasm.length });
  return {
    typeUrl: MSG_SUBMIT_PROPOSAL_TYPE_URL,
    value: {
      messages: storeCodeProposalMessages(gz),
      initialDeposit: [{ denom: "uqor", amount: input.depositUqor.toString() }],
      proposer: requireQor(input.proposer, "proposer"),
      metadata: "",
      title: text.title,
      summary: text.summary,
      expedited: input.expedited,
    },
  };
}

/**
 * The proposal's messages in the REST (`/cosmos/gov/v1/proposals/<id>`)
 * JSON shape, with the code replaced by its length, so it can be compared
 * field by field with Diana proposal 40.
 */
export function storeCodeProposalShape(gzippedWasm: Uint8Array) {
  const breaker = (type: string) => ({ "@type": type, authority: GOV_MODULE_ADDRESS, msg_type_urls: [MSG_STORE_CODE] });
  return [
    breaker(MSG_RESET_BREAKER),
    { "@type": MSG_STORE_CODE, sender: GOV_MODULE_ADDRESS, wasm_byte_code: `<${gzippedWasm.length} bytes gzip>`, instantiate_permission: { permission: "Everybody", addresses: [] } },
    breaker(MSG_TRIP_BREAKER),
  ];
}

type RestMessage = Record<string, unknown> & { "@type"?: string };

/**
 * Differences between our three messages and the first three of a reference
 * proposal (Diana proposal 40). Empty when they match in everything but the code.
 */
export function compareWithReference(ours: RestMessage[], reference: RestMessage[]): string[] {
  const diffs: string[] = [];
  ours.forEach((mine, index) => {
    const theirs = reference[index];
    if (!theirs) {
      diffs.push(`message ${index}: missing in the reference`);
      return;
    }
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    for (const key of keys) {
      if (key === "wasm_byte_code") {
        if (typeof theirs[key] !== "string") diffs.push(`message ${index}: reference has no wasm_byte_code`);
        continue;
      }
      if (JSON.stringify(mine[key]) !== JSON.stringify(theirs[key])) diffs.push(`message ${index} ${key}: ours ${JSON.stringify(mine[key])}, reference ${JSON.stringify(theirs[key])}`);
    }
  });
  return diffs;
}

/** Sanity check: the gzip in the proposal unpacks to exactly the wasm that was checksummed. */
export function assertGzipRoundTrip(gz: Uint8Array, wasm: Uint8Array) {
  const back = new Uint8Array(gunzipSync(gz));
  if (sha256Hex(back) !== sha256Hex(wasm)) throw new Error("gzip round trip changed the code");
}

// ---------------------------------------------------------------------------
// Instantiate, register_stage, claim
// ---------------------------------------------------------------------------

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Admin defaults to the owner, so a fixed version can be migrated in place by the owner. */
export function instantiateMsg(input: { sender: string; codeId: bigint; owner: string; admin?: string; label?: string }) {
  if (input.codeId <= 0n) throw new Error("--code-id must be a positive number");
  const owner = requireQor(input.owner, "--owner");
  const admin = input.admin === "" ? "" : requireQor(input.admin ?? owner, "--admin");
  return {
    typeUrl: MSG_INSTANTIATE,
    value: MsgInstantiateContract.fromPartial({
      sender: requireQor(input.sender, "sender"),
      admin,
      codeId: input.codeId,
      label: input.label?.trim() || "qwakk-rewards",
      msg: json({ owner }),
      funds: [],
    }),
  };
}

/** What `npm run rewards -- finalize --out stage.json` writes (indexer/rewards-config.ts `stageJson`). */
export type StageFile = { stageId: bigint; merkleRoot: string; total: bigint; denom: string; poolId: bigint; start: bigint; end: bigint; label: string };

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

function wholeNumber(value: unknown, name: string, max: bigint): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text) || BigInt(text) > max) throw new Error(`stage file: ${name} must be a whole number`);
  return BigInt(text);
}

/**
 * Reads the indexer's stage file as it is: `stage_id`, `root` (or
 * `merkle_root`), `total`, `denom`, `pool_id`, `start`, `end` (Unix seconds,
 * the claim window) and `label`. Field checks mirror the contract's.
 */
export function parseStageFile(raw: string): StageFile {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("stage file: not JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("stage file: expected an object");
  const root = String(data.root ?? data.merkle_root ?? "").trim().toLowerCase();
  if (data.root !== undefined && data.merkle_root !== undefined && String(data.root).toLowerCase() !== String(data.merkle_root).toLowerCase()) throw new Error("stage file: root and merkle_root differ");
  if (!/^[0-9a-f]{64}$/.test(root)) throw new Error("stage file: root must be 64 hex characters");
  const denom = typeof data.denom === "string" ? data.denom.trim() : "";
  if (!/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(denom)) throw new Error("stage file: denom is not a bank denom");
  const label = typeof data.label === "string" ? data.label : "";
  if (label.length > 128) throw new Error("stage file: label is longer than 128 characters");
  const stage: StageFile = {
    stageId: wholeNumber(data.stage_id, "stage_id", MAX_U64),
    merkleRoot: root,
    total: wholeNumber(data.total, "total", MAX_U128),
    denom,
    poolId: wholeNumber(data.pool_id, "pool_id", MAX_U64),
    start: wholeNumber(data.start, "start", MAX_U64),
    end: wholeNumber(data.end, "end", MAX_U64),
    label,
  };
  if (stage.stageId < 1n) throw new Error("stage file: stage_id starts at 1");
  if (stage.total < 1n) throw new Error("stage file: total must be positive");
  if (stage.end <= stage.start) throw new Error("stage file: end must be after start");
  return stage;
}

/**
 * Leaves bind the stage id, so a stage file only works as the contract's next
 * stage. Also refuses a window that has already closed.
 */
export function checkStageAgainstContract(stage: StageFile, contract: { stageCount: bigint; nowSeconds: bigint }) {
  const next = contract.stageCount + 1n;
  if (stage.stageId !== next) throw new Error(`stage file is for stage ${stage.stageId}, but the contract's next stage is ${next}. Its proofs would not verify. Nothing was sent.`);
  if (stage.end <= contract.nowSeconds) throw new Error("the stage's claim window has already ended. Nothing was sent.");
}

/** ExecuteMsg JSON written by hand so u64 fields never pass through a JS number. */
export function registerStageBody(stage: StageFile): string {
  return `{"register_stage":{"denom":${JSON.stringify(stage.denom)},"merkle_root":"${stage.merkleRoot}","total":"${stage.total}","start":${stage.start},"end":${stage.end},"pool_id":${stage.poolId},"label":${JSON.stringify(stage.label)}}}`;
}

/** register_stage carries exactly the stage total of the stage denom, and nothing else. */
export function registerStageMsg(input: { sender: string; contract: string; stage: StageFile }) {
  return {
    typeUrl: MSG_EXECUTE,
    value: MsgExecuteContract.fromPartial({
      sender: requireQor(input.sender, "sender"),
      contract: requireQor(input.contract, "QWAKK_REWARDS_CONTRACT_ADDRESS"),
      msg: new TextEncoder().encode(registerStageBody(input.stage)),
      funds: [{ denom: input.stage.denom, amount: input.stage.total.toString() }],
    }),
  };
}

/** A claim, for testing with the deployer; the app builds the same message for QoreX (lib/qwakk-native-rewards.ts). */
export function claimMsg(input: { sender: string; contract: string; stageId: bigint; amount: bigint; proof: string[] }) {
  if (input.stageId < 1n || input.amount < 1n) throw new Error("stage and amount must be positive");
  const proof = input.proof.map((p) => p.trim().toLowerCase());
  if (proof.some((p) => !/^[0-9a-f]{64}$/.test(p))) throw new Error("each proof entry must be 64 hex characters");
  return {
    typeUrl: MSG_EXECUTE,
    value: MsgExecuteContract.fromPartial({
      sender: requireQor(input.sender, "sender"),
      contract: requireQor(input.contract, "QWAKK_REWARDS_CONTRACT_ADDRESS"),
      msg: new TextEncoder().encode(`{"claim":{"stage_id":${input.stageId},"amount":"${input.amount}","proof":[${proof.map((p) => `"${p}"`).join(",")}]}}`),
      funds: [],
    }),
  };
}

/** A simple execute without funds (reclaim, pause, resume, ownership). */
export function executeMsg(input: { sender: string; contract: string; body: unknown }) {
  return {
    typeUrl: MSG_EXECUTE,
    value: MsgExecuteContract.fromPartial({ sender: requireQor(input.sender, "sender"), contract: requireQor(input.contract, "QWAKK_REWARDS_CONTRACT_ADDRESS"), msg: json(input.body), funds: [] }),
  };
}
