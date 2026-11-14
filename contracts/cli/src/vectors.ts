/**
 * vectors.ts: write real ML-DSA-87 test vectors for the Foundry tests.
 *
 *   npm run vectors            write ../test/fixtures/pq-vectors.json
 *   npm run vectors -- --live  also check every vector against QoreChain Diana's
 *                              pqcVerify precompile (read-only eth_call, nothing is sent)
 *
 * Keys come from fixed, public, test-only seeds and signing is deterministic
 * (FIPS 204 with rnd = 0, the @qorechain/pqc default), so the file is
 * reproducible byte for byte. These keys guard nothing: never fund them.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mldsa87 } from "@qorechain/pqc";
import { pqcVerify as sdkPqcVerify } from "@qorechain/sdk";
import { IQORE_PQC_ABI, PRECOMPILE_ADDRESSES } from "@qorechain/evm";
import { bytesToHex, decodeFunctionResult, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToHex, type Address, type Hex } from "viem";
import { encodeApprovalMessage, NATIVE_TOKEN, VaultAction, type ApprovalFields } from "./message.js";

const OUT = fileURLToPath(new URL("../../test/fixtures/pq-vectors.json", import.meta.url));
const DIANA_EVM_RPC = process.env.QORE_EVM_RPC_URL?.trim() || "https://evm-testnet.qore.host";

function seed(label: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(`qwakk-pond-vault/test-vector/${label}`).digest());
}

function fixedAddress(label: string): Address {
  return getAddress(`0x${keccak256(stringToHex(`qwakk-pond-vault/${label}`)).slice(-40)}`);
}

export const TEST_CHAIN_ID = 9800n;
/** Every vector expires here; the tests warp to NOW first. */
export const TEST_DEADLINE = 1_900_000_000n;
export const TEST_NOW = TEST_DEADLINE - 3_600n;

export const TEST_ADDRESSES = {
  vault: fixedAddress("vault"),
  otherVault: fixedAddress("other-vault"),
  owner: fixedAddress("owner"),
  guardian: fixedAddress("guardian"),
  recipient: fixedAddress("recipient"),
  token: fixedAddress("token"),
  approverB: fixedAddress("approver-b"),
  newOwner: fixedAddress("new-owner"),
  newGuardian: fixedAddress("new-guardian"),
} as const;

type Signer = "A" | "B";
type VectorSpec = { signer: Signer; fields: ApprovalFields };

function specs(): Record<string, VectorSpec> {
  const a = TEST_ADDRESSES;
  const base = { chainId: TEST_CHAIN_ID, vault: a.vault, deadline: TEST_DEADLINE, token: NATIVE_TOKEN, to: NATIVE_TOKEN, amount: 0n, nonce: 0n };
  const oneQor = 10n ** 18n;
  return {
    withdrawQor: { signer: "A", fields: { ...base, action: VaultAction.Withdraw, to: a.recipient, amount: oneQor } },
    capToken: { signer: "A", fields: { ...base, action: VaultAction.SetDailyCap, token: a.token, amount: 1_000_000_000n } },
    withdrawToken: { signer: "A", fields: { ...base, action: VaultAction.Withdraw, token: a.token, to: a.recipient, amount: 250_000_000n, nonce: 1n } },
    setTimelock: { signer: "A", fields: { ...base, action: VaultAction.SetTimelock, amount: 3_600n } },
    setOwner: { signer: "A", fields: { ...base, action: VaultAction.SetOwner, to: a.newOwner } },
    setGuardian: { signer: "A", fields: { ...base, action: VaultAction.SetGuardian, to: a.newGuardian } },
    unpause: { signer: "A", fields: { ...base, action: VaultAction.Unpause } },
    setApproverB: { signer: "A", fields: { ...base, action: VaultAction.SetApprover, to: a.approverB } },
    withdrawQorByB: { signer: "B", fields: { ...base, action: VaultAction.Withdraw, to: a.recipient, amount: oneQor, nonce: 1n } },
    withdrawQorByANonce1: { signer: "A", fields: { ...base, action: VaultAction.Withdraw, to: a.recipient, amount: oneQor, nonce: 1n } },
    withdrawQorOtherChain: { signer: "A", fields: { ...base, chainId: 1n, action: VaultAction.Withdraw, to: a.recipient, amount: oneQor } },
    withdrawQorOtherVault: { signer: "A", fields: { ...base, vault: a.otherVault, action: VaultAction.Withdraw, to: a.recipient, amount: oneQor } },
  };
}

async function liveVerify(pubkey: Uint8Array, signature: Uint8Array, message: Hex): Promise<boolean> {
  const data = encodeFunctionData({ abi: IQORE_PQC_ABI, functionName: "pqcVerify", args: [bytesToHex(pubkey), bytesToHex(signature), message] });
  const response = await fetch(DIANA_EVM_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PRECOMPILE_ADDRESSES.pqcVerify, data }, "latest"] }),
  });
  const body = (await response.json()) as { result?: Hex; error?: unknown };
  if (!body.result || body.result === "0x") throw new Error("pqcVerify returned no data (precompile inactive or RPC error)");
  return decodeFunctionResult({ abi: IQORE_PQC_ABI, functionName: "pqcVerify", data: body.result });
}

async function main() {
  const live = process.argv.includes("--live");
  const keys = { A: mldsa87.keygen(seed("approver-a")), B: mldsa87.keygen(seed("approver-b")) };
  const vectors: Record<string, Record<string, string | number | boolean>> = {};

  for (const [name, spec] of Object.entries(specs())) {
    const message = encodeApprovalMessage(spec.fields);
    const key = keys[spec.signer];
    const signature = mldsa87.sign(key.secretKey, hexToBytes(message));
    if (signature.length !== 4627) throw new Error(`${name}: unexpected signature length ${signature.length}`);
    // Two independent official verifiers before anything is written.
    if (!mldsa87.verify(key.publicKey, hexToBytes(message), signature)) throw new Error(`${name}: @qorechain/pqc refused its own signature`);
    if (!sdkPqcVerify(key.publicKey, hexToBytes(message), signature)) throw new Error(`${name}: @qorechain/sdk pqcVerify refused the signature`);

    const entry: Record<string, string | number | boolean> = {
      signer: spec.signer,
      chainId: spec.fields.chainId.toString(),
      vault: spec.fields.vault,
      action: spec.fields.action,
      token: spec.fields.token,
      to: spec.fields.to,
      amount: spec.fields.amount.toString(),
      nonce: spec.fields.nonce.toString(),
      deadline: spec.fields.deadline.toString(),
      message,
      signature: bytesToHex(signature),
    };
    if (live) {
      const valid = await liveVerify(key.publicKey, signature, message);
      const tampered = hexToBytes(message);
      tampered[tampered.length - 1] ^= 1;
      const tamperedValid = await liveVerify(key.publicKey, signature, bytesToHex(tampered));
      if (!valid || tamperedValid) throw new Error(`${name}: Diana pqcVerify answered valid=${valid}, tampered=${tamperedValid}`);
      entry.dianaVerified = true;
      process.stdout.write(`${name}: Diana pqcVerify true, tampered false\n`);
    }
    vectors[name] = entry;
  }

  const file = {
    note: "Real ML-DSA-87 vectors from fixed, public, test-only seeds. Generated by contracts/cli/src/vectors.ts. Never fund these keys.",
    scheme: "ML-DSA-87 (FIPS 204), deterministic signing, empty context",
    generatedWith: "@qorechain/pqc mldsa87, cross-checked with @qorechain/sdk pqcVerify",
    dianaChecked: live,
    now: TEST_NOW.toString(),
    addresses: TEST_ADDRESSES,
    pubkeyA: bytesToHex(keys.A.publicKey),
    pubkeyB: bytesToHex(keys.B.publicKey),
    vectors,
  };
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${Object.keys(vectors).length} vectors to ${OUT}${live ? " (all checked on QoreChain Diana)" : ""}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
