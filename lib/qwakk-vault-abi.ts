/**
 * Read-only ABI pieces for the Qwakk Pond Vault (contracts/src/PondVault.sol).
 *
 * The app does not depend on an EVM library, so the few calls the dashboard
 * makes are encoded and decoded by hand here. Every selector and topic is
 * checked against viem and the compiled contract by
 * contracts/cli/test/abi.test.ts. Pure module: no network, no environment.
 */

/** Function signature to 4-byte selector. */
export const POND_VAULT_SELECTORS = {
  "owner()": "0x8da5cb5b",
  "approver()": "0x141a8dd8",
  "guardian()": "0x452a9320",
  "paused()": "0x5c975abb",
  "timelock()": "0xd33219b4",
  "nonce()": "0xaffed0e0",
  "actionCount()": "0x29da5738",
  "dailyCap(address)": "0x3e3e7973",
  "remainingToday(address)": "0xec52e060",
  "getAction(uint256)": "0xb6e76873",
  "keyStatus(address)": "0xdeb1fd42",
  "balanceOf(address)": "0x70a08231",
} as const;

export type PondVaultCall = keyof typeof POND_VAULT_SELECTORS;

/** Event signature to topic0. */
export const POND_VAULT_TOPICS = {
  "ActionQueued(uint256,uint8,address,address,uint256,uint64,uint64)": "0xeec09aac0584d47b9fa56ec5aaa92a2f58e140fea941f2925f856732d45f690a",
  "ActionExecuted(uint256,uint8)": "0xccbac48ec328eb4bdb4ace10025e03ecf58898746c98bdf8cfd4d32ade75f42a",
  "ActionCancelled(uint256,address)": "0x427c44a594677f66ed055fca2706c0d4447d9f8b97b42b22a3ed9010c2481737",
} as const;

/** `PondVault.Action`, by number. */
export const VAULT_ACTION_NAMES = ["None", "Withdraw", "SetDailyCap", "SetTimelock", "SetOwner", "SetApprover", "SetGuardian", "Unpause"] as const;
export type VaultActionName = (typeof VAULT_ACTION_NAMES)[number];
/** `PondVault.Status`, by number. */
export const VAULT_STATUS_NAMES = ["none", "queued", "executed", "cancelled"] as const;
export type VaultStatusName = (typeof VAULT_STATUS_NAMES)[number];

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return ADDRESS.test(value);
}

function word(hex: string) {
  return hex.padStart(64, "0");
}

/** Calldata for a call that takes nothing, one address or one uint256. */
export function encodeCall(call: PondVaultCall, arg?: string | bigint): string {
  const selector = POND_VAULT_SELECTORS[call];
  if (arg === undefined) return selector;
  if (typeof arg === "bigint") {
    if (arg < BigInt(0) || arg >= BigInt(1) << BigInt(256)) throw new Error("uint256 out of range");
    return selector + word(arg.toString(16));
  }
  if (!isEvmAddress(arg)) throw new Error("not an EVM address");
  return selector + word(arg.slice(2).toLowerCase());
}

/** The 32-byte words of ABI return data, without the 0x. */
export function words(data: string): string[] {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length === 0 || hex.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("malformed ABI data");
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

export const asUint = (w: string) => BigInt(`0x${w}`);
export const asBool = (w: string) => asUint(w) === BigInt(1);
export function asAddress(w: string): string {
  if (!/^0{24}/.test(w)) throw new Error("not an address word");
  return `0x${w.slice(24)}`;
}

export type VaultActionView = {
  action: VaultActionName;
  status: VaultStatusName;
  nonce: bigint;
  eta: bigint;
  token: string;
  to: string;
  amount: bigint;
};

/** `getAction(id)` returns a static tuple: seven words in declaration order. */
export function decodeAction(data: string): VaultActionView {
  const w = words(data);
  if (w.length !== 7) throw new Error("getAction returns seven words");
  const action = VAULT_ACTION_NAMES[Number(asUint(w[0]))];
  const status = VAULT_STATUS_NAMES[Number(asUint(w[1]))];
  if (!action || !status) throw new Error("unknown action or status");
  return { action, status, nonce: asUint(w[2]), eta: asUint(w[3]), token: asAddress(w[4]), to: asAddress(w[5]), amount: asUint(w[6]) };
}

/** A base-unit amount as a decimal string, integer math only, trailing zeros trimmed. */
export function formatBaseUnits(value: bigint, decimals: number, maxFraction = 6): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("bad decimals");
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0").slice(0, Math.min(decimals, maxFraction)).replace(/0+$/, "");
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = fraction ? `${wholeText}.${fraction}` : wholeText;
  return negative ? `-${text}` : text;
}

/** A positive amount too small to show at `maxFraction` digits reads as "<0.000001". */
export function displayAmount(value: bigint, decimals: number, maxFraction = 6): string {
  const text = formatBaseUnits(value, decimals, maxFraction);
  if (value > BigInt(0) && /^0(\.0*)?$/.test(text)) return `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return text;
}
