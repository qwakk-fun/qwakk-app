import { qorechainRegistry, type EncodeObject } from "@qorechain/sdk";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AuthInfo, Fee, ModeInfo, SignerInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import type { QoreXMessage } from "@/lib/qorex-native";

/**
 * Qwakk only ever asks QoreX to sign native AMM messages, plus the disclosed
 * interface fee transfer next to a swap. Anything else is refused before it
 * reaches the wallet.
 */
export const NATIVE_AMM_MESSAGE_TYPES = new Set([
  "/qorechain.amm.v1.MsgCreatePool",
  "/qorechain.amm.v1.MsgAddLiquidity",
  "/qorechain.amm.v1.MsgRemoveLiquidity",
  "/qorechain.amm.v1.MsgSwapExactIn",
  "/qorechain.amm.v1.MsgSwapExactOut",
]);

const SWAP_TYPES = new Set(["/qorechain.amm.v1.MsgSwapExactIn", "/qorechain.amm.v1.MsgSwapExactOut"]);
const SEND_TYPE = "/cosmos.bank.v1beta1.MsgSend";

export type TxResult = { code: number; codespace: string; txhash: string; height: string; rawLog: string };

/**
 * Reads the account sequence from any auth account shape Diana returns (a base
 * account, or one nested inside an eth or vesting account). Simulation needs
 * only the sequence.
 */
export function findAccountSequence(value: unknown): bigint | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sequence = record.sequence;
  if (typeof record.address === "string" && (typeof sequence === "string" || typeof sequence === "number")) return BigInt(sequence);
  for (const nested of Object.values(record)) {
    const found = findAccountSequence(nested);
    if (found !== null) return found;
  }
  return null;
}

/** Returns null when the account has never received funds on Diana. */
export async function readAccountSequence(address: string): Promise<bigint | null> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Account query failed");
  const sequence = findAccountSequence(await response.json());
  if (sequence === null) throw new Error("Unsupported account response");
  return sequence;
}

/**
 * Whether QoreChain already holds this account's post-quantum key. When it does
 * not, QoreX registers it in a separate transaction before the first action.
 * Returns null when the answer is unknown; it never blocks an action.
 */
export async function readPqcKeyRegistered(address: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${QORECHAIN_REST_URL}/qorechain/pqc/v1/account/${encodeURIComponent(address)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { found?: unknown };
    return typeof body.found === "boolean" ? body.found : null;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Protobuf-encodes each message with the official QoreChain registry. */
export function encodeAsAny(messages: readonly EncodeObject[]): Any[] {
  const registry = qorechainRegistry();
  return messages.map((message) => registry.encodeAsAny(message));
}

/** The `{ typeUrl, value }` list QoreX `signAndBroadcast` takes, with base64 values. */
export function toWalletMessages(encoded: readonly Any[]): QoreXMessage[] {
  return encoded.map((message) => ({ typeUrl: message.typeUrl, value: bytesToBase64(message.value) }));
}

/**
 * A message set may go to the wallet when every message is a native AMM
 * message, or when a swap is paired with Qwakk's interface fee: one transfer
 * from the sender to the configured treasury. Any other transfer is refused.
 */
export function isAllowedMessageSet(messages: readonly Any[], sender: string, treasury?: string) {
  if (!messages.length) return false;
  const sends = messages.filter((message) => message.typeUrl === SEND_TYPE);
  const others = messages.filter((message) => message.typeUrl !== SEND_TYPE);
  if (others.some((message) => !NATIVE_AMM_MESSAGE_TYPES.has(message.typeUrl))) return false;
  if (!sends.length) return true;
  if (!treasury || sends.length > 1 || !others.some((message) => SWAP_TYPES.has(message.typeUrl))) return false;
  const send = MsgSend.decode(sends[0].value);
  return send.toAddress === treasury && send.fromAddress === sender;
}

type TxResponseEnvelope = { tx_response?: { code?: number | string; codespace?: string; txhash?: string; height?: string | number; raw_log?: string } };

function toTxResult(envelope: TxResponseEnvelope): TxResult | null {
  const response = envelope.tx_response;
  if (!response?.txhash) return null;
  return {
    code: Number(response.code ?? 0),
    codespace: response.codespace ?? "",
    txhash: response.txhash,
    height: String(response.height ?? ""),
    rawLog: response.raw_log ?? "",
  };
}

/** Returns null while the transaction is not yet included in a block. */
export async function readTxResult(hash: string): Promise<TxResult | null> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error("Transaction query failed");
  return toTxResult(await response.json() as TxResponseEnvelope);
}

/**
 * QoreX prices the fee itself at its average gas price step (0.15 uqor per
 * gas, QoreX 0.3.5) and the dApp cannot change it. Qwakk mirrors that formula
 * only to show the expected fee: ceil(gasLimit * 0.15).
 */
const GAS_PRICE_NUMERATOR = BigInt(15);
const GAS_PRICE_DENOMINATOR = BigInt(100);
/** Simulated gas varies a little between runs, so add a margin. */
const GAS_MARGIN_PERCENT = BigInt(130);
/**
 * Simulation runs a classical-only transaction. The wallet adds the ML-DSA
 * post-quantum layer (about 5 KB), which Diana measured at about 77k to 91k
 * extra gas for a MsgSend (89,318 simulated classical vs 166,421 to 180,071
 * used by QoreX hybrid sends). 100k keeps that covered.
 */
export const PQC_GAS_HEADROOM = BigInt(100_000);
/** QoreX clamps every gas limit to this range. */
export const QOREX_MIN_GAS = BigInt(100_000);
export const QOREX_MAX_GAS = BigInt(5_000_000);

export function gasLimitForSimulatedGas(gasUsed: bigint) {
  const gas = (gasUsed * GAS_MARGIN_PERCENT) / BigInt(100) + PQC_GAS_HEADROOM;
  if (gas < QOREX_MIN_GAS) return QOREX_MIN_GAS;
  if (gas > QOREX_MAX_GAS) return QOREX_MAX_GAS;
  return gas;
}

/** The network fee in uqor QoreX charges for a gas limit, rounded up like the wallet. */
export function networkFeeForGas(gasLimit: bigint) {
  return (gasLimit * GAS_PRICE_NUMERATOR + GAS_PRICE_DENOMINATOR - BigInt(1)) / GAS_PRICE_DENOMINATOR;
}

export type SimulationFailure =
  | "insufficient_funds"
  | "network_fee"
  | "pool_creation_fee"
  | "pool_not_found"
  | "pool_exists"
  | "pool_paused"
  | "price_moved"
  | "impact_too_high"
  | "insufficient_liquidity"
  | "below_min_liquidity"
  | "pool_limit"
  | "module_disabled"
  | "rejected";

/** One ABCI event from a simulation, attribute values as plain strings. */
export type ChainEvent = { type: string; attributes: Array<{ key: string; value: string }> };

export type SimulationResult = { ok: true; gasUsed: bigint; events: ChainEvent[] } | { ok: false; failure: SimulationFailure };

/**
 * Maps chain error text to a fixed reason. The raw text never leaves the
 * server. Texts come from qorechain-core `x/amm/types/errors.go` and the
 * Cosmos SDK bank keeper. The impact cap check runs before the slippage check,
 * because the keeper may report the cap through its slippage error.
 */
export function classifySimulationError(message: string): SimulationFailure {
  const text = message.toLowerCase();
  if (text.includes("insufficient funds") || text.includes("smaller than")) return "insufficient_funds";
  if (text.includes("pool not found")) return "pool_not_found";
  if (text.includes("pool already exists")) return "pool_exists";
  if (text.includes("pool is paused")) return "pool_paused";
  if (text.includes("impact")) return "impact_too_high";
  if (text.includes("slippage tolerance exceeded")) return "price_moved";
  if (text.includes("insufficient liquidity")) return "insufficient_liquidity";
  if (text.includes("below minimum liquidity")) return "below_min_liquidity";
  if (text.includes("reached max pools")) return "pool_limit";
  return "rejected";
}

/** Draft fee for simulation only. Kept small so a low balance is not refused for a fee it would never pay. */
const SIMULATION_FEE = { amount: [{ denom: "uqor", amount: "30000" }], gasLimit: BigInt(1_000_000) };

/**
 * An unsigned transaction used only for `/simulate`. Simulation skips
 * signature checks and, without a public key, the SDK uses its stand-in key, so
 * no wallet key or signature is needed. This is never broadcast.
 */
export function buildSimulationTx(encoded: readonly Any[], sequence: bigint, memo = "") {
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: [...encoded], memo })).finish();
  const authInfoBytes = AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [SignerInfo.fromPartial({
      modeInfo: ModeInfo.fromPartial({ single: { mode: SignMode.SIGN_MODE_DIRECT } }),
      sequence,
    })],
    fee: Fee.fromPartial(SIMULATION_FEE),
  })).finish();
  return TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [new Uint8Array(64)] })).finish();
}

function decodeAttribute(value: unknown, base64: boolean) {
  const text = typeof value === "string" ? value : "";
  if (!base64) return text;
  try {
    return Buffer.from(text, "base64").toString("utf8");
  } catch {
    return text;
  }
}

/**
 * Reads `result.events` from a `/cosmos/tx/v1beta1/simulate` response. Diana
 * (Cosmos SDK 0.53) returns plain-text attributes; older nodes returned
 * base64, which is detected by the always-present `msg_index` key.
 */
export function parseSimulationEvents(body: unknown): ChainEvent[] {
  const events = (body as { result?: { events?: unknown } } | null)?.result?.events;
  if (!Array.isArray(events)) return [];
  const raw = events.filter((event): event is { type: string; attributes?: Array<{ key?: unknown; value?: unknown }> } => Boolean(event) && typeof (event as { type?: unknown }).type === "string");
  // "bXNnX2luZGV4" and "c2VuZGVy" are base64 for "msg_index" and "sender".
  const base64 = raw.some((event) => (event.attributes ?? []).some((attribute) => attribute.key === "bXNnX2luZGV4" || attribute.key === "c2VuZGVy"));
  return raw.map((event) => ({
    type: event.type,
    attributes: (event.attributes ?? []).map((attribute) => ({ key: decodeAttribute(attribute.key, base64), value: decodeAttribute(attribute.value, base64) })),
  }));
}

/** Attributes of the first event of a type, as a key to value map. */
export function eventAttributes(events: readonly ChainEvent[], type: string): Map<string, string> | null {
  const event = events.find((candidate) => candidate.type === type);
  return event ? new Map(event.attributes.map((attribute) => [attribute.key, attribute.value])) : null;
}

export type Coin = { denom: string; amount: string };

/** Parses a coin list such as "100uqor,5ibc/ABC". Unparseable parts are dropped. */
export function parseCoins(text: string): Coin[] {
  return text.split(",").map((part) => /^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]{1,127})$/.exec(part.trim())).filter((match): match is RegExpExecArray => match !== null).map((match) => ({ amount: match[1], denom: match[2] }));
}

/**
 * What the chain's own keeper reports it would do, read from the AMM events of
 * a simulation (`x/amm/types/events.go`). Only fields that parse are set.
 */
export type SimulatedOutcome = {
  swap?: { amountIn: string; denomIn: string; amountOut: string; denomOut: string };
  lpMinted?: string;
  lpBurned?: string;
  tokensIn?: Coin[];
  tokensOut?: Coin[];
  poolId?: string;
};

export function simulatedOutcome(events: readonly ChainEvent[]): SimulatedOutcome {
  const outcome: SimulatedOutcome = {};
  const integer = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? value : undefined;
  const swap = eventAttributes(events, "amm_swap");
  if (swap) {
    const amountIn = integer(swap.get("amount_in"));
    const amountOut = integer(swap.get("amount_out"));
    if (amountIn && amountOut) outcome.swap = { amountIn, denomIn: swap.get("denom_in") ?? "", amountOut, denomOut: swap.get("denom_out") ?? "" };
  }
  for (const type of ["amm_pool_created", "amm_liquidity_added", "amm_liquidity_removed"]) {
    const attributes = eventAttributes(events, type);
    if (!attributes) continue;
    outcome.poolId ??= integer(attributes.get("pool_id"));
    outcome.lpMinted ??= integer(attributes.get("lp_minted"));
    outcome.lpBurned ??= integer(attributes.get("lp_burned"));
    const tokensIn = parseCoins(attributes.get("tokens_in") ?? "");
    const tokensOut = parseCoins(attributes.get("tokens_out") ?? "");
    if (tokensIn.length && !outcome.tokensIn) outcome.tokensIn = tokensIn;
    if (tokensOut.length && !outcome.tokensOut) outcome.tokensOut = tokensOut;
  }
  return outcome;
}

/** Runs the messages through the chain without broadcasting them. */
export async function simulateMessages(encoded: readonly Any[], sequence: bigint, memo = ""): Promise<SimulationResult> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/tx/v1beta1/simulate`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tx_bytes: bytesToBase64(buildSimulationTx(encoded, sequence, memo)) }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => null) as { gas_info?: { gas_used?: string }; message?: string } | null;
  if (response.ok && /^\d+$/.test(body?.gas_info?.gas_used ?? "")) return { ok: true, gasUsed: BigInt(body?.gas_info?.gas_used as string), events: parseSimulationEvents(body) };
  if (typeof body?.message === "string") {
    console.warn("QoreChain simulation refused a transaction", body.message);
    return { ok: false, failure: classifySimulationError(body.message) };
  }
  throw new Error("Simulation request failed");
}

/**
 * Everything the messages take out of the sender's bank balance, per denom:
 * transfers, swap inputs, deposits and, for a new pool, the pool creation fee
 * in uqor (charged on top of the deposits, `x/amm/types/params.go`). The
 * network fee is added separately.
 */
export function requiredSpend(encoded: readonly Any[], options: { poolCreationFee?: bigint } = {}) {
  const registry = qorechainRegistry();
  const spend = new Map<string, bigint>();
  const add = (coin: { denom?: string; amount?: string } | undefined) => {
    if (!coin?.denom || !/^\d+$/.test(coin.amount ?? "")) return;
    spend.set(coin.denom, (spend.get(coin.denom) ?? BigInt(0)) + BigInt(coin.amount as string));
  };
  for (const message of encoded) {
    const decoded = registry.decode(message) as Record<string, unknown>;
    switch (message.typeUrl) {
      case SEND_TYPE:
        for (const coin of (decoded.amount as Array<{ denom: string; amount: string }>) ?? []) add(coin);
        break;
      case "/qorechain.amm.v1.MsgSwapExactIn":
        add(decoded.tokenIn as { denom: string; amount: string });
        break;
      case "/qorechain.amm.v1.MsgSwapExactOut":
        add({ denom: decoded.denomIn as string, amount: decoded.maxIn as string });
        break;
      case "/qorechain.amm.v1.MsgAddLiquidity":
        add(decoded.amountA as { denom: string; amount: string });
        add(decoded.amountB as { denom: string; amount: string });
        break;
      case "/qorechain.amm.v1.MsgCreatePool":
        add(decoded.initialDepositA as { denom: string; amount: string });
        add(decoded.initialDepositB as { denom: string; amount: string });
        if (options.poolCreationFee && options.poolCreationFee > BigInt(0)) add({ denom: "uqor", amount: options.poolCreationFee.toString() });
        break;
    }
  }
  return spend;
}

/**
 * Compares the spend plus the network fee with the balances. Returns the most
 * specific reason the transaction cannot be paid for, or null when it fits.
 */
export function balanceShortfall(spend: ReadonlyMap<string, bigint>, balances: ReadonlyMap<string, bigint>, networkFee: bigint, options: { poolCreationFee?: bigint } = {}): SimulationFailure | null {
  for (const [denom, amount] of spend) {
    const held = balances.get(denom) ?? BigInt(0);
    if (held >= amount) continue;
    const creationFee = options.poolCreationFee ?? BigInt(0);
    if (denom === "uqor" && creationFee > BigInt(0) && held >= amount - creationFee) return "pool_creation_fee";
    return "insufficient_funds";
  }
  const uqor = (spend.get("uqor") ?? BigInt(0)) + networkFee;
  return (balances.get("uqor") ?? BigInt(0)) >= uqor ? null : "network_fee";
}

export type PreparedWalletTx = {
  chainId: string;
  messages: QoreXMessage[];
  memo: string;
  gasLimit: string;
  /** Expected network fee in uqor at QoreX's gas price. QoreX shows the final figure. */
  fee: { amount: string; denom: "uqor" };
  /** False when QoreX will first register the post-quantum key in its own transaction; null when unknown. */
  pqcKeyRegistered: boolean | null;
  /** What QoreChain's keeper reported in the simulation, such as the exact swap output. */
  simulated: SimulatedOutcome;
};

export type PrepareOutcome =
  | { ok: true; prepared: PreparedWalletTx }
  | { ok: false; reason: "unfunded" }
  | { ok: false; reason: "simulation"; failure: SimulationFailure };

/**
 * Simulates already validated messages against Diana and turns them into a
 * `signAndBroadcast` request. Nothing is signed or broadcast here.
 */
export async function prepareWalletTx(input: {
  address: string;
  chainId: string;
  encoded: readonly Any[];
  memo?: string;
  /** When set, the bank balance must cover every amount, this pool creation fee and the network fee. */
  balanceCheck?: { poolCreationFee?: bigint; readBalances: (address: string) => Promise<ReadonlyMap<string, bigint>> };
}): Promise<PrepareOutcome> {
  const memo = input.memo ?? "";
  const [sequence, pqcKeyRegistered] = await Promise.all([readAccountSequence(input.address), readPqcKeyRegistered(input.address)]);
  if (sequence === null) return { ok: false, reason: "unfunded" };

  const [simulation, balances] = await Promise.all([
    simulateMessages(input.encoded, sequence, memo),
    input.balanceCheck ? input.balanceCheck.readBalances(input.address) : Promise.resolve(null),
  ]);
  if (!simulation.ok) {
    // The chain's bank error does not say whether the creation fee is the gap.
    if (simulation.failure === "insufficient_funds" && balances && input.balanceCheck) {
      const shortfall = balanceShortfall(requiredSpend(input.encoded, input.balanceCheck), balances, BigInt(0), input.balanceCheck);
      if (shortfall === "pool_creation_fee") return { ok: false, reason: "simulation", failure: shortfall };
    }
    return { ok: false, reason: "simulation", failure: simulation.failure };
  }

  const gasLimit = gasLimitForSimulatedGas(simulation.gasUsed);
  if (balances && input.balanceCheck) {
    // Simulation pays a small draft fee, so check the real network fee here.
    const shortfall = balanceShortfall(requiredSpend(input.encoded, input.balanceCheck), balances, networkFeeForGas(gasLimit), input.balanceCheck);
    if (shortfall) return { ok: false, reason: "simulation", failure: shortfall };
  }
  return {
    ok: true,
    prepared: {
      chainId: input.chainId,
      messages: toWalletMessages(input.encoded),
      memo,
      gasLimit: gasLimit.toString(),
      fee: { amount: networkFeeForGas(gasLimit).toString(), denom: "uqor" },
      pqcKeyRegistered,
      simulated: simulatedOutcome(simulation.events),
    },
  };
}
