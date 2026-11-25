/**
 * QWAKK and QCAT on QoreChain Diana: pure helpers for the token CLI (no network, no keys).
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
 * - Registration proposals: cosmos/evm v0.6.3 proto/cosmos/evm/erc20/v1/tx.proto
 *   (MsgRegisterERC20: signer = 1, erc20addresses = 2, repeated) inside
 *   cosmos.gov.v1.MsgSubmitProposal. Diana's proposal 38 (submit tx
 *   F4D76890B5F0B9E42CDC936A9314E323C86273DC3F04CBD92487AFA25084EE74, height
 *   10327279, a hybrid-signed Native-lane transaction) is the byte-for-byte
 *   reference in the tests.
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

/** QCAT (Quantum Cat), the QCAT community meme token. Must match src/QcatToken.sol. */
export const QCAT = {
  name: "Quantum Cat",
  symbol: "QCAT",
  decimals: 6,
  /** 1,000,000,000 QCAT in base units. */
  totalSupply: 1_000_000_000n * 10n ** 6n,
} as const;

/** A token the CLI can deploy and move: its constants, its Foundry contract and the env var holding its address. */
export type TokenSpec = {
  key: "qwakk" | "qcat";
  /** The Foundry contract name: src/<contract>.sol, out/<contract>.sol/<contract>.json. */
  contract: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** contracts/.env variable with the deployed EIP-55 address. */
  addressEnv: string;
};

export const TOKENS: Record<TokenSpec["key"], TokenSpec> = {
  qwakk: { key: "qwakk", contract: "QwakkToken", ...QWAKK, addressEnv: "QWAKK_TOKEN_ADDRESS" },
  qcat: { key: "qcat", contract: "QcatToken", ...QCAT, addressEnv: "QCAT_TOKEN_ADDRESS" },
};

/** `--token qwakk|qcat`; QWAKK when not given, so every QWAKK command keeps working as before. */
export function tokenSpec(raw: string | undefined): TokenSpec {
  const key = (raw?.trim() || "qwakk").toLowerCase();
  if (key !== "qwakk" && key !== "qcat") throw new Error(`--token must be one of: ${Object.keys(TOKENS).join(", ")}`);
  return TOKENS[key];
}

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
export function parseTokenAddress(raw: string | undefined, envName = "QWAKK_TOKEN_ADDRESS"): string {
  const value = raw?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Set ${envName} in contracts/.env to the 0x address \`npm run token -- deploy\` printed.`);
  }
  if (value !== toChecksumAddress(value)) {
    throw new Error(`${envName} must use its EIP-55 spelling ${toChecksumAddress(value)}: the bank denom is case sensitive.`);
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

/** Token amount to base units: "all" takes the whole `available`; otherwise up to `decimals` places, never above `available`. */
export function parseTokenAmount(raw: string | undefined, available: bigint, token: { symbol: string; decimals: number }): bigint {
  const value = raw?.trim() ?? "";
  let amount: bigint;
  if (value.toLowerCase() === "all") {
    amount = available;
  } else {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) throw new Error(`Give the amount in ${token.symbol}, for example 1000000 or 0.5, or "all"`);
    const fraction = match[2] ?? "";
    if (fraction.length > token.decimals) throw new Error(`${token.symbol} has ${token.decimals} decimals`);
    amount = BigInt(match[1]) * 10n ** BigInt(token.decimals) + BigInt(fraction.padEnd(token.decimals, "0") || "0");
  }
  if (amount <= 0n) throw new Error("The amount must be greater than zero (and there must be something to move)");
  if (amount > available) throw new Error(`Only ${formatTokenAmount(available, token.decimals)} ${token.symbol} is available here`);
  return amount;
}

/** Base units to a decimal string, exact. */
export function formatTokenAmount(base: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = base / scale;
  const fraction = (base % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** QWAKK amount to base units (parseTokenAmount for QWAKK). */
export function parseQwakkAmount(raw: string | undefined, available: bigint): bigint {
  return parseTokenAmount(raw, available, QWAKK);
}

/** Base units to a QWAKK string, exact. */
export function formatQwakk(base: bigint): string {
  return formatTokenAmount(base, QWAKK.decimals);
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

// ---------------------------------------------------------------------------
// Registration proposal (governance only on Diana: permissionless_registration false)
// ---------------------------------------------------------------------------

export const MSG_REGISTER_ERC20_TYPE_URL = "/cosmos.evm.erc20.v1.MsgRegisterERC20";
export const MSG_SUBMIT_PROPOSAL_TYPE_URL = "/cosmos.gov.v1.MsgSubmitProposal";

/**
 * The gov module account, sha256("gov")[:20] in qor1 form. MsgRegisterERC20's
 * `signer` must be this authority (proposal 26 and 38 on Diana; the node also
 * answers it at /cosmos/auth/v1beta1/module_accounts/gov, which the CLI checks
 * before it sends).
 */
export const GOV_MODULE_ADDRESS = "qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3";

/** cosmos.evm.erc20.v1.MsgRegisterERC20 (tx.proto): signer = 1, erc20addresses = 2 (repeated string). */
export function encodeMsgRegisterERC20(msg: { signer: string; erc20addresses: string[] }): Uint8Array {
  return Uint8Array.from([...stringField(1, msg.signer), ...msg.erc20addresses.flatMap((a) => stringField(2, a))]);
}

/** Title and summary in the form of Diana proposal 38 (the QWAKK registration). */
export function registrationProposalText(address: string, token: { name: string; symbol: string; decimals: number; totalSupply: bigint }) {
  const supply = formatTokenAmount(token.totalSupply, token.decimals);
  return {
    title: `Register the ${token.name} (${token.symbol}) ERC-20 as a native token pair (testnet)`,
    summary:
      `Testnet only. Registers the ERC-20 contract ${address} (${token.name}, ${token.symbol}, ${token.decimals} decimals, ` +
      `fixed supply ${supply} minted once to the deployer; no owner, mint, pause, blocklist or transfer fee) as a token pair, ` +
      `so it can be converted to and used as the native denom ${bankDenomFor(address)}.`,
  };
}

/**
 * cosmos.gov.v1.MsgSubmitProposal carrying one MsgRegisterERC20 for one
 * contract (one proposal per address: Diana proposal 24 failed as a duplicate
 * of 26). The SDK's registry (cosmjs-types) encodes the outer message; the
 * inner one goes in as ready-made Any bytes.
 */
export function registrationProposalMsg(input: {
  token: string;
  spec: { name: string; symbol: string; decimals: number; totalSupply: bigint };
  proposer: string;
  depositUqor: bigint;
  expedited: boolean;
}) {
  if (input.depositUqor <= 0n) throw new Error("the deposit must be positive");
  const { title, summary } = registrationProposalText(input.token, input.spec);
  return {
    typeUrl: MSG_SUBMIT_PROPOSAL_TYPE_URL,
    value: {
      messages: [{ typeUrl: MSG_REGISTER_ERC20_TYPE_URL, value: encodeMsgRegisterERC20({ signer: GOV_MODULE_ADDRESS, erc20addresses: [input.token] }) }],
      initialDeposit: [{ denom: "uqor", amount: input.depositUqor.toString() }],
      proposer: input.proposer,
      metadata: "",
      title,
      summary,
      expedited: input.expedited,
    },
  };
}
