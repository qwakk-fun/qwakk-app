/**
 * Token send on the native rail: exactly one bank `MsgSend` of one coin from
 * the connected account to another `qor1` account. It exists because the
 * QoreX Send screen does not list `erc20:0x…` bank denoms (QWAKK, QCAT), while
 * QoreX `signAndBroadcast` signs a `/cosmos.bank.v1beta1.MsgSend` for them
 * (owner's console send of QWAKK confirmed on QoreChain Diana, 2026-11-25).
 *
 * The message is built with the official `@qorechain/sdk` 0.8.2 `bank.send`
 * composer (`dist/index.d.ts`, `declare const bank`) and encoded with
 * `qorechainRegistry()`. It carries no Qwakk interface fee. LP shares are not
 * bank coins (`x/amm/types/lp_balance.go`), so they cannot be sent this way.
 */
import { bank, bech32ToHex, type EncodeObject } from "@qorechain/sdk";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import type { Any } from "cosmjs-types/google/protobuf/any";

import { isQoreAddress } from "@/lib/qwakk-native-rewards";
import { SEND_KIND, isSendableDenom, type SendAction } from "@/lib/qwakk-send-action";
import { SEND_COPY } from "@/lib/qwakk-tx-copy";

export { SEND_KIND, isSendableDenom, sendAction, type SendAction } from "@/lib/qwakk-send-action";

export const BANK_SEND_TYPE = "/cosmos.bank.v1beta1.MsgSend";

const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

/**
 * A `qor1` account address: lower case, valid bech32 checksum (SDK
 * `isValidBech32`, which decodes with checksum verification) and a 20-byte
 * payload. 32-byte contract addresses are refused: this sends to wallets.
 */
export function isQoreAccountAddress(value: string) {
  if (!isQoreAddress(value)) return false;
  try {
    return bech32ToHex(value).length === 42;
  } catch {
    return false;
  }
}

/** Narrows untrusted JSON into a send action. Field checks happen in `checkSend`. */
export function parseSendAction(input: Record<string, unknown>): SendAction {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return { kind: SEND_KIND, toAddress: text(input.toAddress), denom: text(input.denom), amount: text(input.amount) };
}

/**
 * Validates a send for `sender` and returns it in canonical form (amount
 * without leading zeros). Throws fixed copy from `SEND_COPY`.
 */
export function checkSend(sender: string, action: Pick<SendAction, "toAddress" | "denom" | "amount">) {
  if (!isQoreAccountAddress(sender)) throw new Error("Connect a QoreChain wallet first");
  if (!isQoreAccountAddress(action.toAddress)) throw new Error(SEND_COPY.invalid_recipient);
  if (action.toAddress === sender) throw new Error(SEND_COPY.self_send);
  if (!isSendableDenom(action.denom)) throw new Error(SEND_COPY.invalid_denom);
  if (!/^\d{1,39}$/.test(action.amount)) throw new Error(SEND_COPY.invalid_amount);
  const amount = BigInt(action.amount);
  if (amount <= BigInt(0) || amount > U128_MAX) throw new Error(SEND_COPY.invalid_amount);
  return { toAddress: action.toAddress, denom: action.denom, amount: amount.toString() };
}

/** The one message a send signs, from the connected account. */
export function buildSendMessage(sender: string, action: Pick<SendAction, "toAddress" | "denom" | "amount">): EncodeObject {
  const { toAddress, denom, amount } = checkSend(sender, action);
  return bank.send({ fromAddress: sender, toAddress, amount: [{ denom, amount }] });
}

/**
 * The relay's narrow exception for sends: exactly one MsgSend, from the
 * sender, to the recipient the server validated, of exactly the one coin the
 * server built. It is checked only for a send action; the swap allow-list
 * (`isAllowedMessageSet`) still refuses a lone transfer.
 */
export function isAllowedSend(messages: readonly Any[], sender: string, expected: Pick<SendAction, "toAddress" | "denom" | "amount">) {
  if (messages.length !== 1 || messages[0].typeUrl !== BANK_SEND_TYPE) return false;
  let canonical: ReturnType<typeof checkSend>;
  try {
    canonical = checkSend(sender, expected);
  } catch {
    return false;
  }
  let decoded: MsgSend;
  try {
    decoded = MsgSend.decode(messages[0].value);
  } catch {
    return false;
  }
  if (decoded.fromAddress !== sender || decoded.toAddress !== canonical.toAddress) return false;
  if (decoded.amount.length !== 1) return false;
  const [coin] = decoded.amount;
  return coin.denom === canonical.denom && coin.amount === canonical.amount;
}

/**
 * The exact denom the sender holds for a requested one, or null. Denoms are
 * case sensitive on QoreChain (`erc20:0x…` keeps the case the chain reported,
 * see lib/qwakk-assets.ts), so the send uses the balance's own spelling.
 */
export function heldDenom(balances: ReadonlyMap<string, bigint>, denom: string): string | null {
  if (balances.has(denom)) return denom;
  const wanted = denom.toLowerCase();
  for (const held of balances.keys()) if (held.toLowerCase() === wanted) return held;
  return null;
}
