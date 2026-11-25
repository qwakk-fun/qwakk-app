/**
 * Qwakk rewards claim on the native rail: one CosmWasm MsgExecuteContract
 * `{ claim: { stage_id, amount, proof } }` with no funds, sent by the connected
 * account to the configured qwakk-rewards contract (contracts/rewards).
 *
 * QoreX `signAndBroadcast` signs MsgExecuteContract for native accounts and
 * re-simulates wasm messages itself (QoreX 0.4.3, live tx 5BFDF1FD...8477 on
 * QoreChain Diana). `@qorechain/sdk` 0.8.2 `qorechainRegistry()` has no
 * `cosmwasm.wasm.v1` types, so the message is encoded with `cosmjs-types`
 * 0.11 (`cosmwasm/wasm/v1/tx`).
 *
 * The Merkle encoding is the contract's (contracts/rewards/src/merkle.rs):
 * leaf = sha256("qwakk-rewards-v1" || u64_be(stage_id) || u8(len(address)) || address || u128_be(amount)),
 * node = sha256(min(a, b) || max(a, b)).
 */
import { isValidBech32, sha256 } from "@qorechain/sdk";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

export const WASM_EXECUTE_TYPE = "/cosmwasm.wasm.v1.MsgExecuteContract";

export const REWARDS_CLAIM_KIND = "rewards_claim";

/** What the UI sends to `/api/native-tx/prepare` as `action`. All numbers are base-10 strings. */
export type RewardsClaimAction = {
  kind: typeof REWARDS_CLAIM_KIND;
  /** The contract stage id (from 1). */
  stageId: string;
  /** Reward base units, exactly as allocated in the stage's tree. */
  amount: string;
  /** Sibling hashes, 64 hex characters each, bottom up. */
  proof: string[];
};

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
/** The contract refuses longer proofs (MAX_PROOF_LEN). */
export const MAX_REWARDS_PROOF_LENGTH = 64;
const HASH = /^[0-9a-f]{64}$/;

/** A bech32 `qor1` address with a valid checksum: 20-byte accounts and 32-byte contracts. */
export function isQoreAddress(value: string) {
  return /^qor1[02-9ac-hj-np-z]{38,90}$/.test(value) && isValidBech32(value, "qor");
}

export type RewardsEnv = Readonly<Record<string, string | undefined>>;

/**
 * The rewards contract for this deployment, or null (claims off). It is the
 * same `QWAKK_REWARDS_CONTRACT_ADDRESS` the indexer stores with each epoch,
 * set per deployment like the network itself. CosmWasm is open on QoreChain
 * Diana only (docs: developer-guide/cosmwasm-development), so mainnet stays off.
 */
export function resolveRewardsContract(env: RewardsEnv, networkId: "testnet" | "mainnet"): { contract: string | null; warning: string | null } {
  const value = env.QWAKK_REWARDS_CONTRACT_ADDRESS?.trim() ?? "";
  if (!value) return { contract: null, warning: null };
  if (networkId !== "testnet") return { contract: null, warning: "QWAKK_REWARDS_CONTRACT_ADDRESS is set but rewards claims run on QoreChain Diana only. Claims are off." };
  if (!isQoreAddress(value)) return { contract: null, warning: "QWAKK_REWARDS_CONTRACT_ADDRESS is not a valid qor1 address. Claims are off." };
  return { contract: value, warning: null };
}

/** Narrows untrusted JSON into a claim action. Field checks happen in the builder. */
export function parseRewardsClaimAction(input: Record<string, unknown>): RewardsClaimAction {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  return {
    kind: REWARDS_CLAIM_KIND,
    stageId: text(input.stageId),
    amount: text(input.amount),
    proof: Array.isArray(input.proof) ? input.proof.map((entry) => typeof entry === "string" ? entry.trim().toLowerCase() : "") : [],
  };
}

/** Validates a claim and returns it in canonical form (lowercase hex, no leading zeros). Throws fixed messages. */
export function checkRewardsClaim(claim: Pick<RewardsClaimAction, "stageId" | "amount" | "proof">) {
  if (!/^\d{1,20}$/.test(claim.stageId) || BigInt(claim.stageId) < BigInt(1) || BigInt(claim.stageId) > U64_MAX) throw new Error("Choose a valid rewards stage");
  if (!/^\d{1,39}$/.test(claim.amount) || BigInt(claim.amount) <= BigInt(0) || BigInt(claim.amount) > U128_MAX) throw new Error("The reward amount must be a positive whole number");
  if (claim.proof.length > MAX_REWARDS_PROOF_LENGTH) throw new Error("This reward proof is not valid");
  const proof = claim.proof.map((entry) => entry.toLowerCase());
  if (proof.some((entry) => !HASH.test(entry))) throw new Error("This reward proof is not valid");
  return { stageId: BigInt(claim.stageId).toString(), amount: BigInt(claim.amount).toString(), proof };
}

/**
 * The contract's ExecuteMsg JSON. Written by hand so a u64 stage id never
 * passes through a JS number; every part is validated first.
 */
export function rewardsClaimMsgJson(claim: Pick<RewardsClaimAction, "stageId" | "amount" | "proof">) {
  const { stageId, amount, proof } = checkRewardsClaim(claim);
  return `{"claim":{"stage_id":${stageId},"amount":"${amount}","proof":[${proof.map((entry) => `"${entry}"`).join(",")}]}}`;
}

/**
 * The one message a claim sends, protobuf-encoded as `Any`, ready for
 * `toWalletMessages`. The sender is the connected account; no funds.
 */
export function buildRewardsClaimMessage(input: { sender: string; contract: string } & Pick<RewardsClaimAction, "stageId" | "amount" | "proof">): Any {
  if (!isQoreAddress(input.sender)) throw new Error("Connect a QoreChain wallet first");
  if (!isQoreAddress(input.contract)) throw new Error("Rewards claims are not available right now");
  const msg = new TextEncoder().encode(rewardsClaimMsgJson(input));
  return {
    typeUrl: WASM_EXECUTE_TYPE,
    value: MsgExecuteContract.encode(MsgExecuteContract.fromPartial({ sender: input.sender, contract: input.contract, msg, funds: [] })).finish(),
  };
}

/**
 * The relay's narrow exception for rewards: exactly one MsgExecuteContract
 * from the sender to the configured contract, no funds, and a body that is a
 * well-formed `claim` and nothing else.
 */
export function isAllowedRewardsClaim(messages: readonly Any[], sender: string, contract: string | null | undefined) {
  if (!contract || messages.length !== 1 || messages[0].typeUrl !== WASM_EXECUTE_TYPE) return false;
  let decoded: MsgExecuteContract;
  try {
    decoded = MsgExecuteContract.decode(messages[0].value);
  } catch {
    return false;
  }
  if (decoded.sender !== sender || decoded.contract !== contract || decoded.funds.length > 0) return false;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded.msg));
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "claim") return false;
  const claim = (body as { claim?: unknown }).claim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  const fields = claim as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "amount,proof,stage_id") return false;
  if (typeof fields.stage_id !== "number" || typeof fields.amount !== "string" || !Array.isArray(fields.proof)) return false;
  try {
    // Re-encode and compare, so only the canonical form passes.
    const stageText = /"stage_id":(\d+)/.exec(new TextDecoder().decode(decoded.msg))?.[1] ?? "";
    return rewardsClaimMsgJson({ stageId: stageText, amount: fields.amount, proof: fields.proof as string[] }) === new TextDecoder().decode(decoded.msg);
  } catch {
    return false;
  }
}

/** The leaf of one allocation, as the contract computes it. */
export function rewardsLeaf(stageId: string, address: string, amount: string): Uint8Array {
  const { stageId: stage, amount: value } = checkRewardsClaim({ stageId, amount, proof: [] });
  const addressBytes = new TextEncoder().encode(address);
  if (addressBytes.length > 255) throw new Error("Address too long");
  const bytes = new Uint8Array(16 + 8 + 1 + addressBytes.length + 16);
  bytes.set(new TextEncoder().encode("qwakk-rewards-v1"), 0);
  new DataView(bytes.buffer).setBigUint64(16, BigInt(stage));
  bytes[24] = addressBytes.length;
  bytes.set(addressBytes, 25);
  const amountView = new DataView(bytes.buffer, 25 + addressBytes.length, 16);
  amountView.setBigUint64(0, BigInt(value) >> BigInt(64));
  amountView.setBigUint64(8, BigInt(value) & ((BigInt(1) << BigInt(64)) - BigInt(1)));
  return sha256(bytes);
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function hexToBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hex leaf, for comparing with the indexer's `leaf` field. */
export function rewardsLeafHex(stageId: string, address: string, amount: string) {
  return bytesToHex(rewardsLeaf(stageId, address, amount));
}

/**
 * Checks a claim against a stage root before anything is sent, exactly as
 * the contract will. A false here means the chain would refuse the claim.
 */
export function verifyRewardsProof(input: { stageId: string; address: string; amount: string; proof: string[]; root: string }) {
  try {
    const { proof } = checkRewardsClaim(input);
    if (!HASH.test(input.root.toLowerCase())) return false;
    let hash = rewardsLeaf(input.stageId, input.address, input.amount);
    for (const sibling of proof.map(hexToBytes)) {
      const [lo, hi] = compareBytes(hash, sibling) <= 0 ? [hash, sibling] : [sibling, hash];
      const joined = new Uint8Array(64);
      joined.set(lo, 0);
      joined.set(hi, 32);
      hash = sha256(joined);
    }
    return bytesToHex(hash) === input.root.toLowerCase();
  } catch {
    return false;
  }
}

const warned = new Set<string>();

/**
 * Server only: the configured rewards contract for this deployment's network,
 * or null. Read per request, so a CapRover change applies without a rebuild.
 */
export function rewardsClaimContract(env: RewardsEnv = process.env, networkId: "testnet" | "mainnet" = "testnet"): string | null {
  const { contract, warning } = resolveRewardsContract(env, networkId);
  if (warning && !warned.has(warning)) {
    warned.add(warning);
    console.warn(`[qwakk-rewards] ${warning}`);
  }
  return contract;
}

/**
 * The action the UI sends for one claim the indexer returned
 * (`QwakkRewardClaim` in lib/qwakk-rewards.ts: `stageId`, `amount`, `proof`).
 * Pass it to `useNativeTransaction().run(...)`.
 */
export function rewardsClaimAction(claim: { stageId: number | string; amount: string; proof: readonly string[] }): RewardsClaimAction {
  return { kind: REWARDS_CLAIM_KIND, stageId: String(claim.stageId), amount: claim.amount, proof: [...claim.proof] };
}
