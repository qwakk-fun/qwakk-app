import { ETHSECP256K1_PUBKEY_TYPE, bytesToBech32, qorechainRegistry, ripemd160, sha256, type EncodeObject } from "@qorechain/sdk";
import { PubKey } from "cosmjs-types/cosmos/crypto/secp256k1/keys";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AuthInfo, Fee, ModeInfo, SignerInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";

/**
 * Only native AMM messages may pass through Qora's broadcast relay. Anything
 * else is refused so the relay cannot be used for unrelated transactions.
 */
export const RELAYABLE_MESSAGE_TYPES = new Set([
  "/qorechain.amm.v1.MsgCreatePool",
  "/qorechain.amm.v1.MsgAddLiquidity",
  "/qorechain.amm.v1.MsgRemoveLiquidity",
  "/qorechain.amm.v1.MsgSwapExactIn",
  "/qorechain.amm.v1.MsgSwapExactOut",
]);

export const SECP256K1_PUBKEY_TYPE = "/cosmos.crypto.secp256k1.PubKey";

/**
 * QoreX signs native transactions with a classical Cosmos secp256k1 wallet
 * (SHA-256 sign bytes). Unified eth_secp256k1 accounts use keccak instead.
 */
export type WalletKeyType = "secp256k1" | "eth_secp256k1";

export type AccountAuth = { accountNumber: bigint; sequence: bigint };
export type NativeFee = { amount: Array<{ denom: string; amount: string }>; gas: string };

export type UnsignedNativeTx = {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  accountNumber: bigint;
};

export type BroadcastResult = { code: number; codespace: string; txhash: string; rawLog: string };

/** Reads account number and sequence from any auth account shape Diana returns. */
export function findAccountInfo(value: unknown): AccountAuth | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const accountNumber = record.account_number ?? record.accountNumber;
  const sequence = record.sequence;
  if ((typeof accountNumber === "string" || typeof accountNumber === "number") &&
      (typeof sequence === "string" || typeof sequence === "number")) {
    return { accountNumber: BigInt(accountNumber), sequence: BigInt(sequence) };
  }
  for (const nested of Object.values(record)) {
    const found = findAccountInfo(nested);
    if (found) return found;
  }
  return null;
}

/** Returns null when the account has never received funds on Diana. */
export async function readAccountAuth(address: string): Promise<AccountAuth | null> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Account query failed");
  const info = findAccountInfo(await response.json());
  if (!info) throw new Error("Unsupported account response");
  return info;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("Invalid base64 value");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function parseCompressedPublicKey(hex: string) {
  const clean = hex.replace(/^0x/i, "");
  if (!/^0[23][0-9a-f]{64}$/i.test(clean)) throw new Error("A compressed wallet public key is required");
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** The address a classical Cosmos secp256k1 key controls: ripemd160(sha256(pubkey)). */
export function classicalAddressFromPublicKey(publicKey: Uint8Array) {
  return bytesToBech32(ripemd160(sha256(publicKey)), "qor");
}

/**
 * Builds the SIGN_MODE_DIRECT body and auth info for a wallet key. The wallet
 * signs these bytes; Qora never sees a private key.
 */
export function buildUnsignedNativeTx(input: {
  messages: readonly EncodeObject[];
  publicKey: Uint8Array;
  keyType: WalletKeyType;
  account: AccountAuth;
  fee: NativeFee;
  memo?: string;
}): UnsignedNativeTx {
  const registry = qorechainRegistry();
  const bodyBytes = TxBody.encode(TxBody.fromPartial({
    messages: input.messages.map((message) => registry.encodeAsAny(message)),
    memo: input.memo ?? "",
  })).finish();

  const authInfoBytes = AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [SignerInfo.fromPartial({
      publicKey: {
        typeUrl: input.keyType === "eth_secp256k1" ? ETHSECP256K1_PUBKEY_TYPE : SECP256K1_PUBKEY_TYPE,
        value: PubKey.encode(PubKey.fromPartial({ key: input.publicKey })).finish(),
      },
      modeInfo: ModeInfo.fromPartial({ single: { mode: SignMode.SIGN_MODE_DIRECT } }),
      sequence: input.account.sequence,
    })],
    fee: Fee.fromPartial({ amount: input.fee.amount, gasLimit: BigInt(input.fee.gas) }),
  })).finish();

  return { bodyBytes, authInfoBytes, accountNumber: input.account.accountNumber };
}

export function messageTypesInBody(bodyBytes: Uint8Array) {
  return TxBody.decode(bodyBytes).messages.map((message) => message.typeUrl);
}

export function assembleSignedTx(bodyBytes: Uint8Array, authInfoBytes: Uint8Array, signature: Uint8Array) {
  if (signature.length !== 64) throw new Error("Unexpected wallet signature length");
  return TxRaw.encode(TxRaw.fromPartial({ bodyBytes, authInfoBytes, signatures: [signature] })).finish();
}

type TxResponseEnvelope = { tx_response?: { code?: number | string; codespace?: string; txhash?: string; raw_log?: string } };

function toBroadcastResult(envelope: TxResponseEnvelope): BroadcastResult | null {
  const response = envelope.tx_response;
  if (!response?.txhash) return null;
  return {
    code: Number(response.code ?? 0),
    codespace: response.codespace ?? "",
    txhash: response.txhash,
    rawLog: response.raw_log ?? "",
  };
}

/** Sync mode returns after CheckTx, so signature checks are already decided. */
export async function broadcastTxSync(txBytes: Uint8Array): Promise<BroadcastResult> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/tx/v1beta1/txs`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tx_bytes: bytesToBase64(txBytes), mode: "BROADCAST_MODE_SYNC" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Broadcast request failed");
  const result = toBroadcastResult(await response.json() as TxResponseEnvelope);
  if (!result) throw new Error("Broadcast returned no transaction hash");
  return result;
}

/** Returns null while the transaction is not yet included in a block. */
export async function readTxResult(hash: string): Promise<BroadcastResult | null> {
  const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error("Transaction query failed");
  return toBroadcastResult(await response.json() as TxResponseEnvelope);
}
