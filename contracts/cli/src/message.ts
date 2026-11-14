/**
 * The Pond Vault approval message, byte for byte as `PondVault._message` builds it:
 *
 *   "qwakk-vault-v1" (bytes14) | chainid (uint256) | vault (address) | action (uint8)
 *   | token (address) | to (address) | amount (uint256) | nonce (uint256) | deadline (uint256)
 *
 * Every field is fixed width, so the packed encoding is unambiguous (203 bytes).
 * Pure functions only: no network, no keys.
 */
import { encodePacked, getAddress, isAddress, keccak256, stringToHex, zeroAddress, type Address, type Hex } from "viem";

export const VAULT_DOMAIN = "qwakk-vault-v1";
export const VAULT_DOMAIN_HEX: Hex = stringToHex(VAULT_DOMAIN, { size: 14 });
export const APPROVAL_MESSAGE_LENGTH = 14 + 32 + 20 + 1 + 20 + 20 + 32 + 32 + 32;

/** Must match `PondVault.Action`. The numbers are signed: never reorder. */
export const VaultAction = {
  None: 0,
  Withdraw: 1,
  SetDailyCap: 2,
  SetTimelock: 3,
  SetOwner: 4,
  SetApprover: 5,
  SetGuardian: 6,
  Unpause: 7,
} as const;
export type VaultActionName = Exclude<keyof typeof VaultAction, "None">;
export type VaultActionId = (typeof VaultAction)[keyof typeof VaultAction];

export const ACTION_NAMES: Record<number, VaultActionName> = {
  1: "Withdraw",
  2: "SetDailyCap",
  3: "SetTimelock",
  4: "SetOwner",
  5: "SetApprover",
  6: "SetGuardian",
  7: "Unpause",
};

/** Mirrors the contract constants. */
export const MIN_TIMELOCK = 60n;
export const MAX_TIMELOCK = 30n * 24n * 3600n;
export const MAX_APPROVAL_TTL = 24n * 3600n;
export const NATIVE_TOKEN: Address = zeroAddress;

export type ApprovalFields = {
  chainId: bigint;
  vault: Address;
  action: VaultActionId;
  token: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

const UINT256_MAX = (1n << 256n) - 1n;

function checkUint(name: string, value: bigint) {
  if (value < 0n || value > UINT256_MAX) throw new Error(`${name} must be a uint256`);
}

function checkAddress(name: string, value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is not a 0x address`);
  return getAddress(value);
}

/** The exact bytes the approver signs. Throws on a malformed field. */
export function encodeApprovalMessage(fields: ApprovalFields): Hex {
  checkUint("chainId", fields.chainId);
  checkUint("amount", fields.amount);
  checkUint("nonce", fields.nonce);
  checkUint("deadline", fields.deadline);
  if (!Number.isInteger(fields.action) || fields.action < 1 || fields.action > 7) {
    throw new Error("action must be 1 to 7");
  }
  return encodePacked(
    ["bytes14", "uint256", "address", "uint8", "address", "address", "uint256", "uint256", "uint256"],
    [
      VAULT_DOMAIN_HEX,
      fields.chainId,
      checkAddress("vault", fields.vault),
      fields.action,
      checkAddress("token", fields.token),
      checkAddress("to", fields.to),
      fields.amount,
      fields.nonce,
      fields.deadline,
    ],
  );
}

/** The value the vault logs in `ApprovalVerified(nonce, approver, action, messageHash)`. */
export function approvalMessageHash(fields: ApprovalFields): Hex {
  return keccak256(encodeApprovalMessage(fields));
}

/** Read the fields back out of a message, for showing what a signature authorises. */
export function decodeApprovalMessage(message: Hex): ApprovalFields {
  const hex = message.slice(2);
  if (hex.length !== APPROVAL_MESSAGE_LENGTH * 2) throw new Error(`an approval message is ${APPROVAL_MESSAGE_LENGTH} bytes`);
  let at = 0;
  const take = (bytes: number) => {
    const part = hex.slice(at, at + bytes * 2);
    at += bytes * 2;
    return part;
  };
  if (`0x${take(14)}` !== VAULT_DOMAIN_HEX) throw new Error("not a qwakk-vault-v1 message");
  const chainId = BigInt(`0x${take(32)}`);
  const vault = getAddress(`0x${take(20)}`);
  const action = Number.parseInt(take(1), 16) as VaultActionId;
  const token = getAddress(`0x${take(20)}`);
  const to = getAddress(`0x${take(20)}`);
  const amount = BigInt(`0x${take(32)}`);
  const nonce = BigInt(`0x${take(32)}`);
  const deadline = BigInt(`0x${take(32)}`);
  return { chainId, vault, action, token, to, amount, nonce, deadline };
}

/**
 * The same canonical-parameter rules as `PondVault._validate` (minus the
 * on-chain code and key checks), so a bad request fails before anything is signed.
 */
export function validateActionFields(fields: Pick<ApprovalFields, "action" | "token" | "to" | "amount" | "vault">): void {
  const zero = (a: Address) => a.toLowerCase() === zeroAddress;
  const { action, token, to, amount } = fields;
  switch (action) {
    case VaultAction.Withdraw:
      if (zero(to) || to.toLowerCase() === fields.vault.toLowerCase() || amount === 0n) {
        throw new Error("a withdrawal needs a recipient other than the vault and an amount above zero");
      }
      return;
    case VaultAction.SetDailyCap:
      if (!zero(to)) throw new Error("SetDailyCap takes no recipient");
      return;
    case VaultAction.SetTimelock:
      if (!zero(token) || !zero(to)) throw new Error("SetTimelock takes only a number of seconds");
      if (amount < MIN_TIMELOCK || amount > MAX_TIMELOCK) throw new Error(`the timelock must be ${MIN_TIMELOCK} to ${MAX_TIMELOCK} seconds`);
      return;
    case VaultAction.SetOwner:
    case VaultAction.SetApprover:
      if (!zero(token) || zero(to) || amount !== 0n) throw new Error("a role change takes only the new address");
      return;
    case VaultAction.SetGuardian:
      if (!zero(token) || amount !== 0n) throw new Error("SetGuardian takes only the new address (0x0 removes the guardian)");
      return;
    case VaultAction.Unpause:
      if (!zero(token) || !zero(to) || amount !== 0n) throw new Error("Unpause takes no fields");
      return;
    default:
      throw new Error("unknown action");
  }
}

/** Deadline for a new approval: now + ttl, refused above the contract's MAX_APPROVAL_TTL. */
export function approvalDeadline(nowSeconds: bigint, ttlSeconds: bigint): bigint {
  if (ttlSeconds <= 0n || ttlSeconds > MAX_APPROVAL_TTL) throw new Error(`the approval lifetime must be 1 to ${MAX_APPROVAL_TTL} seconds`);
  return nowSeconds + ttlSeconds;
}
