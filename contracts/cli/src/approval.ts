/**
 * Build, sign and check a Pond Vault approval.
 *
 * Signing is done locally with the approver's ML-DSA-87 key (the key its
 * account registered on QoreChain). Before a signature is made, the bytes
 * built here are compared with the vault's own `approvalMessage(...)`, so what
 * is signed is exactly what the contract will verify. Before it is used, the
 * signature is checked by the `pqcVerify` precompile itself (an eth_call).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pqcSign, pqcVerify as localVerify, type UnifiedAccount } from "@qorechain/sdk";
import { IQORE_PQC_ABI } from "@qorechain/evm";
import { bytesToHex, getAddress, hexToBytes, isHex, type Address, type Hex, type PublicClient } from "viem";
import { POND_VAULT_ABI } from "./abi.js";
import { PQC_VERIFY_ADDRESS } from "./chain.js";
import {
  ACTION_NAMES,
  approvalDeadline,
  decodeApprovalMessage,
  encodeApprovalMessage,
  validateActionFields,
  type ApprovalFields,
  type VaultActionId,
} from "./message.js";

export type ApprovalFile = {
  kind: "qwakk-pond-vault-approval";
  version: 1;
  approver: Address;
  actionName: string;
  fields: Record<keyof ApprovalFields, string | number>;
  message: Hex;
  signature: Hex;
};

export type ActionRequest = { action: VaultActionId; token: Address; to: Address; amount: bigint };

/** Fields for the vault's next approval: its current nonce, the chain's id and a short deadline. */
export async function nextApprovalFields(client: PublicClient, vault: Address, request: ActionRequest, ttlSeconds: bigint): Promise<ApprovalFields> {
  const [chainId, nonce, block] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: vault, abi: POND_VAULT_ABI, functionName: "nonce" }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  const fields: ApprovalFields = {
    chainId: BigInt(chainId),
    vault,
    action: request.action,
    token: request.token,
    to: request.to,
    amount: request.amount,
    nonce: BigInt(nonce),
    deadline: approvalDeadline(block.timestamp, ttlSeconds),
  };
  validateActionFields(fields);
  return fields;
}

/** Refuse unless the vault encodes these fields to exactly our bytes. */
export async function crossCheckEncoding(client: PublicClient, fields: ApprovalFields): Promise<Hex> {
  const local = encodeApprovalMessage(fields);
  const onChain = await client.readContract({
    address: fields.vault,
    abi: POND_VAULT_ABI,
    functionName: "approvalMessage",
    args: [fields.action, fields.token, fields.to, fields.amount, fields.nonce, fields.deadline],
  });
  if (onChain.toLowerCase() !== local.toLowerCase()) {
    throw new Error("The vault encodes this approval differently from the CLI. Nothing was signed. Check POND_VAULT_ADDRESS and the CLI version.");
  }
  return local;
}

/** The approver key the vault will use, read through the vault itself. */
export async function vaultApproverKey(client: PublicClient, vault: Address): Promise<{ approver: Address; pubkey: Hex }> {
  const approver = await client.readContract({ address: vault, abi: POND_VAULT_ABI, functionName: "approver" });
  const [usable, pubkey] = await client.readContract({ address: vault, abi: POND_VAULT_ABI, functionName: "keyStatus", args: [approver] });
  if (!usable) {
    throw new Error(`The approver ${approver} has no usable ML-DSA-87 key (registered with a proof of possession). Run: npm run pond -- register`);
  }
  return { approver, pubkey };
}

/** Sign with the approver's key, after checking it is the key the vault trusts. */
export function signApproval(approver: UnifiedAccount, trusted: { approver: Address; pubkey: Hex }, message: Hex): Hex {
  if (getAddress(approver.evm) !== getAddress(trusted.approver)) {
    throw new Error(`The vault's approver is ${trusted.approver}, but the approver mnemonic gives ${approver.evm}.`);
  }
  if (bytesToHex(approver.pqc.publicKey).toLowerCase() !== trusted.pubkey.toLowerCase()) {
    throw new Error("The approver's registered ML-DSA-87 key on chain is not the key derived from this mnemonic. Nothing was signed.");
  }
  const signature = pqcSign(approver.pqc.secretKey, hexToBytes(message));
  if (!localVerify(approver.pqc.publicKey, hexToBytes(message), signature)) throw new Error("local ML-DSA-87 verification failed");
  return bytesToHex(signature);
}

/** Ask the pqcVerify precompile itself (eth_call, nothing is sent). */
export async function precompileVerifies(client: PublicClient, pubkey: Hex, signature: Hex, message: Hex): Promise<boolean> {
  return client.readContract({
    address: PQC_VERIFY_ADDRESS,
    abi: IQORE_PQC_ABI,
    functionName: "pqcVerify",
    args: [pubkey, signature, message],
  });
}

export function describe(fields: ApprovalFields, formatAmount: (token: Address, amount: bigint) => string): string[] {
  const name = ACTION_NAMES[fields.action];
  const lines = [
    `  action    ${name} (${fields.action})`,
    `  vault     ${fields.vault} on EVM chain ${fields.chainId}`,
  ];
  if (name === "Withdraw" || name === "SetDailyCap") lines.push(`  token     ${fields.token === "0x0000000000000000000000000000000000000000" ? "QOR (native)" : fields.token}`);
  if (name === "Withdraw" || name === "SetDailyCap") lines.push(`  amount    ${formatAmount(fields.token, fields.amount)}`);
  if (name === "SetTimelock") lines.push(`  timelock  ${fields.amount} seconds`);
  if (name === "SetGuardian" && fields.to.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    lines.push("  to        none: this removes the guardian");
  } else if (name === "Withdraw" || name === "SetOwner" || name === "SetApprover" || name === "SetGuardian") {
    lines.push(`  to        ${fields.to}`);
  }
  lines.push(`  nonce     ${fields.nonce}`);
  lines.push(`  expires   ${new Date(Number(fields.deadline) * 1000).toISOString()}`);
  return lines;
}

export function writeApprovalFile(path: string, approver: Address, fields: ApprovalFields, message: Hex, signature: Hex) {
  const file: ApprovalFile = {
    kind: "qwakk-pond-vault-approval",
    version: 1,
    approver,
    actionName: ACTION_NAMES[fields.action],
    fields: {
      chainId: fields.chainId.toString(),
      vault: fields.vault,
      action: fields.action,
      token: fields.token,
      to: fields.to,
      amount: fields.amount.toString(),
      nonce: fields.nonce.toString(),
      deadline: fields.deadline.toString(),
    },
    message,
    signature,
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Read an approval file and rebuild its message from its fields: the two must agree. */
export function readApprovalFile(path: string): { fields: ApprovalFields; message: Hex; signature: Hex } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ApprovalFile>;
  if (raw.kind !== "qwakk-pond-vault-approval" || raw.version !== 1 || !raw.fields || !raw.message || !raw.signature) {
    throw new Error(`${path} is not a Pond Vault approval file`);
  }
  if (!isHex(raw.message) || !isHex(raw.signature)) throw new Error("approval file: message and signature must be hex");
  const decoded = decodeApprovalMessage(raw.message);
  if (encodeApprovalMessage(decoded).toLowerCase() !== raw.message.toLowerCase()) throw new Error("approval file: message does not round-trip");
  return { fields: decoded, message: raw.message, signature: raw.signature };
}
