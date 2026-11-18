/**
 * QWAKK on QoreChain Diana: pure helpers for the token CLI (no network, no keys).
 *
 * Sources for the chain behaviour encoded here:
 * - cosmos/evm v0.6.3 (the version QoreChain pins in go.mod), x/erc20:
 *   keeper/proposals.go (registerERC20, CreateCoinMetadata), types/utils.go
 *   (SanitizeERC20Name), types/proposal.go (CreateDenom: "erc20:" + address),
 *   keeper/convert.go (ConvertERC20IntoCoinsForNativeToken),
 *   proto/cosmos/evm/erc20/v1/tx.proto (MsgConvertERC20 fields 1 to 4).
 * - qorechain-core app/app_config.go: MsgConvertERC20 is patched at build time
 *   to take a bech32 (qor1) sender.
 * - docs.qorechain.io developer-guide/evm-development#fest-convert: the sender
 *   and the receiver of MsgConvertERC20 are qor1 addresses; the message is a
 *   Native-lane transaction signed hybrid.
 * - Diana, read 2026-11-18: 95 MsgConvertERC20 transactions with code 0, all
 *   with a qor1 sender, for example D53380E8260EAA25A790D35E462AD14E07D13BD879C79C4BD43157E5B5FAE3B6.
 */
import { bech32ToHex, isChecksumAddress, isValidBech32, toChecksumAddress } from "@qorechain/sdk";
import type { qorechainRegistry } from "@qorechain/sdk";

// ---------------------------------------------------------------------------
// The token (must match src/QwakkToken.sol)
// ---------------------------------------------------------------------------

export const QWAKK = {
  name: "Qwakk",
  symbol: "QWAKK",
  decimals: 6,
  /** 1,000,000,000 QWAKK in base units. */
  totalSupply: 1_000_000_000n * 10n ** 6n,
} as const;

/** QoreChain Diana: the only network this CLI sends on. */
export const DIANA = { chainId: "qorechain-diana", evmChainId: 9800 } as const;

/**
 * x/erc20's module account (the first 20 bytes of sha256("erc20")). It holds
 * the ERC-20 side of every converted token. On Diana it is
 * qor1glht96kr2rseywuvhhay894qw7ekuc4q70yeuy, the `coinbase` minter of every
 * MsgConvertERC20.
 */
export const ERC20_MODULE_ADDRESS = "0x47EeB2eac350E1923b8CBDfA4396A077b36E62a0";

/** Gas and fee for a Native-lane transaction: 0.125 uqor per gas, above Diana's 0.1 floor (docs: fest-convert). */
export const NATIVE_GAS_DEFAULT = 800_000n;
export function nativeFeeFor(gas: bigint): bigint {
  return (gas + 7n) / 8n;
}
/** The gas limit to send: the default, or 1.3 x the simulated gas when that is larger. */
export function nativeGasFor(simulated: bigint): bigint {
  const padded = (simulated * 13n + 9n) / 10n;
  return padded > NATIVE_GAS_DEFAULT ? padded : NATIVE_GAS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Refuse anything that is not QoreChain Diana, read from the chain itself. */
export function assertDiana(chain: { chainId: string; evmChainId: number }): void {
  if (chain.chainId !== DIANA.chainId || chain.evmChainId !== DIANA.evmChainId) {
    throw new Error(
      `The QWAKK token tooling runs on QoreChain Diana (${DIANA.chainId}, EVM ${DIANA.evmChainId}) only; ` +
        `this endpoint reports ${chain.chainId || "an unknown chain"}, EVM ${chain.evmChainId}. Nothing was sent.`,
    );
  }
}

/** The token's EVM address: required, a 0x address, and in its EIP-55 spelling (the bank denom is case sensitive). */
export function parseTokenAddress(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("Set QWAKK_TOKEN_ADDRESS in contracts/.env to the 0x address `npm run token -- deploy` printed.");
  }
  if (value !== toChecksumAddress(value)) {
    throw new Error(`QWAKK_TOKEN_ADDRESS must use its EIP-55 spelling ${toChecksumAddress(value)}: the bank denom is case sensitive.`);
  }
  return value;
}

/** A qor1 account address (20 bytes). */
export function parseQorAddress(raw: string | undefined, what: string): string {
  const value = raw?.trim() ?? "";
  if (!value.startsWith("qor1") || !isValidBech32(value, "qor")) throw new Error(`${what} must be a qor1 address`);
  if (bech32ToHex(value).length !== 42) throw new Error(`${what} must be a 20-byte account address`);
  return value;
}

/** The bank denom x/erc20 creates: "erc20:" + the contract address as common.Address.String() spells it (EIP-55). */
export function bankDenomFor(address: string): string {
  if (!isChecksumAddress(address)) throw new Error("bankDenomFor needs the EIP-55 spelling of the address");
  return `erc20:${address}`;
}

// ---------------------------------------------------------------------------
// Amounts (integer math only)
// ---------------------------------------------------------------------------

/** QWAKK amount to base units: "all" takes the whole `available`; otherwise up to 6 decimals, never above `available`. */
export function parseQwakkAmount(raw: string | undefined, available: bigint): bigint {
  const value = raw?.trim() ?? "";
  let amount: bigint;
  if (value.toLowerCase() === "all") {
    amount = available;
  } else {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error('Give the amount in QWAKK, for example 1000000 or 0.5, or "all"');
    const fraction = match[2] ?? "";
    if (fraction.length > QWAKK.decimals) throw new Error(`QWAKK has ${QWAKK.decimals} decimals`);
    amount = BigInt(match[1]) * 10n ** BigInt(QWAKK.decimals) + BigInt(fraction.padEnd(QWAKK.decimals, "0") || "0");
  }
  if (amount <= 0n) throw new Error("The amount must be greater than zero (and there must be something to move)");
  if (amount > available) throw new Error(`Only ${formatQwakk(available)} QWAKK is available here`);
  return amount;
}

/** Base units to a QWAKK string, exact. */
export function formatQwakk(base: bigint): string {
  const scale = 10n ** BigInt(QWAKK.decimals);
  const whole = base / scale;
  const fraction = (base % scale).toString().padStart(QWAKK.decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

// ---------------------------------------------------------------------------
// Bank denom metadata that registration will create
// ---------------------------------------------------------------------------

export type DenomMetadata = {
  description: string;
  denom_units: { denom: string; exponent: number; aliases: string[] }[];
  base: string;
  display: string;
  name: string;
  symbol: string;
};

/** cosmos/evm v0.6.3 types/utils.go SanitizeERC20Name. */
export function sanitizeErc20Name(name: string): string {
  let out = name.replace(/^\d+/gm, "");
  out = out.replace(/^[^A-Za-z]|[^a-zA-Z0-9/:-]/g, "");
  if (out.length > 128) out = out.slice(0, 128);
  for (;;) {
    if (out.startsWith("ibc/")) out = out.slice(4);
    else if (out.startsWith("erc20/") || out.startsWith("erc20:")) out = out.slice(6);
    else return out;
  }
}

/** cosmos/evm v0.6.3 keeper/proposals.go CreateCoinMetadata, for a token with decimals > 0. */
export function expectedBankMetadata(address: string, token: { name: string; symbol: string; decimals: number }): DenomMetadata {
  const base = bankDenomFor(address);
  const display = sanitizeErc20Name(token.name);
  return {
    description: `Cosmos coin token representation of ${address}`,
    denom_units: [
      { denom: base, exponent: 0, aliases: [] },
      { denom: display, exponent: token.decimals, aliases: [] },
    ],
    base,
    display,
    name: base,
    symbol: token.symbol,
  };
}

/** The fields of live metadata that differ from the expected record (empty when they match). */
export function metadataDifferences(live: Partial<DenomMetadata> | undefined, expected: DenomMetadata): string[] {
  if (!live) return ["no bank metadata"];
  const out: string[] = [];
  for (const key of ["description", "base", "display", "name", "symbol"] as const) {
    if (live[key] !== expected[key]) out.push(`${key}: ${JSON.stringify(live[key])} (expected ${JSON.stringify(expected[key])})`);
  }
  const units = (live.denom_units ?? []).map((u) => `${u.denom}@${u.exponent}`).join(",");
  const want = expected.denom_units.map((u) => `${u.denom}@${u.exponent}`).join(",");
  if (units !== want) out.push(`denom_units: ${units} (expected ${want})`);
  return out;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MSG_CONVERT_ERC20_TYPE_URL = "/cosmos.evm.erc20.v1.MsgConvertERC20";
export const MSG_SEND_TYPE_URL = "/cosmos.bank.v1beta1.MsgSend";

/** cosmos.evm.erc20.v1.MsgConvertERC20 (tx.proto): four strings. `amount` is a math.Int, sent as its decimal string. */
export type MsgConvertERC20 = { contractAddress: string; amount: string; receiver: string; sender: string };

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function stringField(field: number, value: string): number[] {
  if (!value) return []; // proto3 omits empty strings
  const bytes = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** Protobuf bytes of MsgConvertERC20. Checked byte for byte against a live Diana transaction in the tests. */
export function encodeMsgConvertERC20(msg: MsgConvertERC20): Uint8Array {
  return Uint8Array.from([
    ...stringField(1, msg.contractAddress),
    ...stringField(2, msg.amount),
    ...stringField(3, msg.receiver),
    ...stringField(4, msg.sender),
  ]);
}

/** Decodes the four string fields (used by the tests and for the confirmation printout). */
export function decodeMsgConvertERC20(bytes: Uint8Array): MsgConvertERC20 {
  const out: MsgConvertERC20 = { contractAddress: "", amount: "", receiver: "", sender: "" };
  const keys = [undefined, "contractAddress", "amount", "receiver", "sender"] as const;
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let result = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error("truncated varint");
      const b = bytes[i++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    if ((tag & 7) !== 2 || field < 1 || field > 4) throw new Error(`unexpected field ${field}`);
    const length = readVarint();
    if (i + length > bytes.length) throw new Error("truncated field");
    out[keys[field]!] = new TextDecoder().decode(bytes.subarray(i, i + length));
    i += length;
  }
  return out;
}

type ExtraTypes = NonNullable<Parameters<typeof qorechainRegistry>[0]>;
type GeneratedType = ExtraTypes[number][1];

/**
 * A cosmjs GeneratedType for MsgConvertERC20, so @qorechain/sdk's
 * qorechainRegistry (which has no erc20 messages in 0.14.0) can encode it.
 */
export const MsgConvertERC20Type = {
  encode: (msg: MsgConvertERC20) => ({ finish: () => encodeMsgConvertERC20(msg) }),
  decode: (input: Uint8Array) => decodeMsgConvertERC20(input),
  fromPartial: (object: Partial<MsgConvertERC20>): MsgConvertERC20 => ({
    contractAddress: object.contractAddress ?? "",
    amount: object.amount ?? "",
    receiver: object.receiver ?? "",
    sender: object.sender ?? "",
  }),
} as unknown as GeneratedType;

export const TOKEN_REGISTRY_TYPES: ExtraTypes = [[MSG_CONVERT_ERC20_TYPE_URL, MsgConvertERC20Type]];

/** ERC-20 balance (EVM side) to bank coin. The signer is `sender`; the bank coin goes to `receiver`. */
export function convertErc20Msg(input: { token: string; amount: bigint; sender: string; receiver: string }) {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  return {
    typeUrl: MSG_CONVERT_ERC20_TYPE_URL,
    value: { contractAddress: input.token, amount: input.amount.toString(), receiver: input.receiver, sender: input.sender } satisfies MsgConvertERC20,
  };
}

/** A bank send of the QWAKK bank coin. */
export function bankSendMsg(input: { denom: string; amount: bigint; from: string; to: string }) {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  return {
    typeUrl: MSG_SEND_TYPE_URL,
    value: { fromAddress: input.from, toAddress: input.to, amount: [{ denom: input.denom, amount: input.amount.toString() }] },
  };
}
