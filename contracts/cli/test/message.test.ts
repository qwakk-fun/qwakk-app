import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mldsa87 } from "@qorechain/pqc";
import { pqcVerify } from "@qorechain/sdk";
import { getAddress, hexToBytes, keccak256, zeroAddress, type Address, type Hex } from "viem";
import {
  APPROVAL_MESSAGE_LENGTH,
  MAX_APPROVAL_TTL,
  VaultAction,
  approvalDeadline,
  approvalMessageHash,
  decodeApprovalMessage,
  encodeApprovalMessage,
  validateActionFields,
  type ApprovalFields,
  type VaultActionId,
} from "../src/message.ts";

type VectorFile = {
  pubkeyA: Hex;
  pubkeyB: Hex;
  vectors: Record<string, { signer: "A" | "B"; chainId: string; vault: Address; action: number; token: Address; to: Address; amount: string; nonce: string; deadline: string; message: Hex; signature: Hex }>;
};

const file = JSON.parse(readFileSync(new URL("../../test/fixtures/pq-vectors.json", import.meta.url), "utf8")) as VectorFile;

function fieldsOf(v: VectorFile["vectors"][string]): ApprovalFields {
  return {
    chainId: BigInt(v.chainId),
    vault: v.vault,
    action: v.action as VaultActionId,
    token: v.token,
    to: v.to,
    amount: BigInt(v.amount),
    nonce: BigInt(v.nonce),
    deadline: BigInt(v.deadline),
  };
}

const sample: ApprovalFields = {
  chainId: 9800n,
  vault: getAddress("0x1111111111111111111111111111111111111111"),
  action: VaultAction.Withdraw,
  token: zeroAddress,
  to: getAddress("0x2222222222222222222222222222222222222222"),
  amount: 10n ** 18n,
  nonce: 7n,
  deadline: 1_900_000_000n,
};

test("encodes every committed vector to the exact signed bytes", () => {
  const names = Object.keys(file.vectors);
  assert.ok(names.length >= 12);
  for (const name of names) {
    const v = file.vectors[name];
    assert.equal(encodeApprovalMessage(fieldsOf(v)), v.message, name);
  }
});

test("every committed signature verifies with both official verifiers", () => {
  for (const [name, v] of Object.entries(file.vectors)) {
    const pub = hexToBytes(v.signer === "B" ? file.pubkeyB : file.pubkeyA);
    assert.ok(mldsa87.verify(pub, hexToBytes(v.message), hexToBytes(v.signature)), `${name} @qorechain/pqc`);
    assert.ok(pqcVerify(pub, hexToBytes(v.message), hexToBytes(v.signature)), `${name} @qorechain/sdk`);
  }
});

test("a signature does not carry over to another nonce, chain or vault", () => {
  const v = file.vectors.withdrawQor;
  const pub = hexToBytes(file.pubkeyA);
  const variants: Partial<ApprovalFields>[] = [{ nonce: 1n }, { chainId: 1n }, { vault: getAddress("0x3333333333333333333333333333333333333333") }, { amount: BigInt(v.amount) + 1n }];
  for (const change of variants) {
    const message = encodeApprovalMessage({ ...fieldsOf(v), ...change });
    assert.equal(pqcVerify(pub, hexToBytes(message), hexToBytes(v.signature)), false, JSON.stringify(change, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  }
});

test("layout: 203 bytes, domain tag first, fixed offsets", () => {
  const m = encodeApprovalMessage(sample);
  assert.equal((m.length - 2) / 2, APPROVAL_MESSAGE_LENGTH);
  assert.equal(APPROVAL_MESSAGE_LENGTH, 203);
  assert.equal(Buffer.from(m.slice(2, 30), "hex").toString("utf8"), "qwakk-vault-v1");
  // action byte sits right after domain (14) + chainid (32) + vault (20)
  assert.equal(m.slice(2 + 66 * 2, 2 + 67 * 2), "01");
  assert.equal(approvalMessageHash(sample), keccak256(m));
});

test("decode is the inverse of encode", () => {
  for (const v of Object.values(file.vectors)) {
    assert.deepEqual(decodeApprovalMessage(v.message), fieldsOf(v));
  }
  assert.throws(() => decodeApprovalMessage("0x00"));
  assert.throws(() => decodeApprovalMessage(`0x${"00".repeat(203)}`), /not a qwakk-vault-v1 message/);
});

test("refuses malformed fields before anything is signed", () => {
  assert.throws(() => encodeApprovalMessage({ ...sample, action: 0 as VaultActionId }));
  assert.throws(() => encodeApprovalMessage({ ...sample, action: 8 as VaultActionId }));
  assert.throws(() => encodeApprovalMessage({ ...sample, amount: -1n }));
  assert.throws(() => encodeApprovalMessage({ ...sample, amount: 1n << 256n }));
  assert.throws(() => encodeApprovalMessage({ ...sample, to: "0x1234" as Address }));
});

test("canonical parameters mirror PondVault._validate", () => {
  const ok = (f: Partial<ApprovalFields>) => validateActionFields({ ...sample, ...f });
  const bad = (f: Partial<ApprovalFields>) => assert.throws(() => validateActionFields({ ...sample, ...f }));
  ok({});
  bad({ to: zeroAddress });
  bad({ amount: 0n });
  bad({ to: sample.vault });
  ok({ action: VaultAction.SetDailyCap, to: zeroAddress, amount: 0n });
  bad({ action: VaultAction.SetDailyCap });
  ok({ action: VaultAction.SetTimelock, to: zeroAddress, amount: 60n });
  bad({ action: VaultAction.SetTimelock, to: zeroAddress, amount: 59n });
  bad({ action: VaultAction.SetTimelock, to: zeroAddress, amount: 30n * 86400n + 1n });
  ok({ action: VaultAction.SetOwner, amount: 0n });
  bad({ action: VaultAction.SetOwner, amount: 1n });
  bad({ action: VaultAction.SetApprover, to: zeroAddress, amount: 0n });
  ok({ action: VaultAction.SetGuardian, to: zeroAddress, amount: 0n });
  ok({ action: VaultAction.Unpause, to: zeroAddress, amount: 0n });
  bad({ action: VaultAction.Unpause, amount: 0n });
});

test("approval lifetime stays within MAX_APPROVAL_TTL", () => {
  assert.equal(approvalDeadline(1_000n, 900n), 1_900n);
  assert.equal(approvalDeadline(1_000n, MAX_APPROVAL_TTL), 1_000n + 86_400n);
  assert.throws(() => approvalDeadline(1_000n, 0n));
  assert.throws(() => approvalDeadline(1_000n, MAX_APPROVAL_TTL + 1n));
});
