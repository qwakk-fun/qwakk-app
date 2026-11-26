import { toBaseAmount } from "./qwakk-assets";
import { SEND_COPY } from "./qwakk-tx-copy";

/**
 * Browser-side checks for the portfolio Send sheet. They mirror the server's
 * own checks in lib/qwakk-native-send.ts (`checkSend`), so a transfer the form
 * accepts is one the prepare route accepts too, and every message is fixed
 * copy. Kept free of React and of `@qorechain/sdk`, so tests can call it and
 * the page bundle stays small.
 */

/** QOR kept back by Max so the network fee (paid in QOR) can still be paid: 0.1 QOR (a transfer costs about 0.04 QOR). */
export const QOR_SEND_RESERVE_UQOR = BigInt(100_000);
export const QOR_SEND_RESERVE_TEXT = "0.1 QOR";

/** Native QOR or a converted ERC-20 bank denom; LP shares never match. */
export { isSendableDenom } from "./qwakk-send-action";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= GENERATOR[bit];
  }
  return checksum;
}

function expandPrefix(prefix: string) {
  const values: number[] = [];
  for (const char of prefix) values.push(char.charCodeAt(0) >>> 5);
  values.push(0);
  for (const char of prefix) values.push(char.charCodeAt(0) & 31);
  return values;
}

/**
 * Decodes a lower-case bech32 string (BIP-173) and verifies its checksum.
 * Returns the prefix and the payload length in bytes, or null.
 */
export function decodeBech32(value: string): { prefix: string; bytes: number } | null {
  if (value.length < 8 || value.length > 90 || value !== value.toLowerCase()) return null;
  const separator = value.lastIndexOf("1");
  if (separator < 1 || separator + 7 > value.length) return null;
  const prefix = value.slice(0, separator);
  const words: number[] = [];
  for (const char of value.slice(separator + 1)) {
    const word = CHARSET.indexOf(char);
    if (word < 0) return null;
    words.push(word);
  }
  if (polymod([...expandPrefix(prefix), ...words]) !== 1) return null;
  // 5-bit words back to 8-bit bytes (BIP-173 convertbits without padding):
  // fewer than 5 bits may be left over, and they must all be zero.
  let accumulator = 0;
  let bits = 0;
  let bytes = 0;
  for (const word of words.slice(0, -6)) {
    accumulator = ((accumulator << 5) | word) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes += 1;
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return null;
  return { prefix, bytes };
}

/** A `qor1` wallet address: valid checksum and a 20-byte account payload (contracts are refused, like the server). */
export function isQoreWalletAddress(value: string) {
  const decoded = decodeBech32(value);
  return decoded !== null && decoded.prefix === "qor" && decoded.bytes === 20;
}

export type RecipientCheck =
  | { state: "empty" }
  | { state: "typing" }
  | { state: "invalid"; message: string }
  | { state: "self"; message: string }
  | { state: "ok"; address: string };

/** A qor1 account address is 42 characters; shorter input is still being typed. */
const ACCOUNT_ADDRESS_LENGTH = 42;

/**
 * Checks what the sender typed or pasted as the recipient. Surrounding spaces
 * are ignored and an all-caps address (bech32 allows it) is read in lower
 * case. `final` treats short input as wrong instead of still typing.
 */
export function checkRecipient(input: string, sender: string, final = false): RecipientCheck {
  const trimmed = input.trim();
  if (!trimmed) return { state: "empty" };
  const value = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
  if (!final && value.length < ACCOUNT_ADDRESS_LENGTH && "qor1".startsWith(value.slice(0, 4)) && /^[a-z0-9]*$/.test(value)) return { state: "typing" };
  if (!isQoreWalletAddress(value)) return { state: "invalid", message: SEND_COPY.invalid_recipient };
  if (value === sender.trim().toLowerCase()) return { state: "self", message: SEND_COPY.self_send };
  return { state: "ok", address: value };
}

/** The most Max puts in the amount: everything, except QOR keeps the fee reserve back. */
export function maxSendable(denom: string, balance: bigint) {
  if (balance <= BigInt(0)) return BigInt(0);
  if (denom !== "uqor") return balance;
  return balance > QOR_SEND_RESERVE_UQOR ? balance - QOR_SEND_RESERVE_UQOR : BigInt(0);
}

export type AmountCheck =
  | { state: "empty" }
  | { state: "invalid"; message: string }
  | { state: "too_much"; message: string }
  | { state: "ok"; amount: string; tight: boolean };

/**
 * Checks a typed amount against the balance. `tight` is true for a QOR send
 * that leaves less than the fee reserve behind: allowed, but worth a warning,
 * since the network fee also comes out of QOR.
 */
export function checkSendAmount(input: string, decimals: number, denom: string, balance: bigint, symbol: string): AmountCheck {
  const text = input.trim();
  if (!text || text === ".") return { state: "empty" };
  let amount: string;
  try {
    amount = toBaseAmount(text, decimals);
  } catch (error) {
    // toBaseAmount throws only its own fixed copy ("This token supports up to 6 decimal places").
    const message = error instanceof Error && /decimal places|whole amounts/.test(error.message) ? `${error.message}.` : SEND_COPY.invalid_amount;
    return { state: "invalid", message };
  }
  const value = BigInt(amount);
  if (value > balance) return { state: "too_much", message: `You hold less ${symbol} than that.` };
  const tight = denom === "uqor" && balance - value < QOR_SEND_RESERVE_UQOR;
  return { state: "ok", amount, tight };
}

/** The base amount written as a plain decimal for the amount field (no grouping, no trailing zeros). */
export function baseToInput(amount: bigint, decimals: number) {
  if (amount <= BigInt(0)) return "0";
  const text = amount.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return text;
  const whole = text.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
