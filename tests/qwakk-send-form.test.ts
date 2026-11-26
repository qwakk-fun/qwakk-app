import assert from "node:assert/strict";
import test from "node:test";

import { hexToBech32, isValidBech32 } from "@qorechain/sdk";

import { QOR_SEND_RESERVE_UQOR, baseToInput, checkRecipient, checkSendAmount, decodeBech32, isQoreWalletAddress, isSendableDenom, maxSendable } from "../lib/qwakk-send-form";
import { SEND_COPY } from "../lib/qwakk-tx-copy";

const SELF = hexToBech32(`0x${"11".repeat(20)}`, "qor");
const OTHER = hexToBech32(`0x${"ab".repeat(20)}`, "qor");
const CONTRACT = hexToBech32(`0x${"cd".repeat(32)}`, "qor");

/** Flips one data character so the checksum no longer matches. */
function corrupt(address: string) {
  const index = 10;
  const swap = address[index] === "q" ? "p" : "q";
  return `${address.slice(0, index)}${swap}${address.slice(index + 1)}`;
}

test("decodes bech32 the same way the QoreChain SDK validates it", () => {
  for (const address of [SELF, OTHER, CONTRACT, hexToBech32(`0x${"00".repeat(20)}`, "qorvaloper")]) {
    assert.equal(decodeBech32(address) !== null, isValidBech32(address), address);
  }
  assert.equal(isValidBech32(corrupt(OTHER)), false);
  assert.equal(decodeBech32(corrupt(OTHER)), null);
  assert.deepEqual(decodeBech32(OTHER), { prefix: "qor", bytes: 20 });
  assert.deepEqual(decodeBech32(CONTRACT), { prefix: "qor", bytes: 32 });
});

test("accepts only qor1 wallet addresses", () => {
  assert.equal(isQoreWalletAddress(OTHER), true);
  assert.equal(isQoreWalletAddress(CONTRACT), false, "contracts are refused, like the server");
  assert.equal(isQoreWalletAddress(hexToBech32(`0x${"ab".repeat(20)}`, "cosmos")), false);
  assert.equal(isQoreWalletAddress(OTHER.toUpperCase()), false, "the decoder itself wants lower case");
  assert.equal(isQoreWalletAddress(`${OTHER.slice(0, 5)}B${OTHER.slice(6)}`), false);
  assert.equal(isQoreWalletAddress(""), false);
});

test("checks the recipient as it is typed", () => {
  assert.deepEqual(checkRecipient("", SELF), { state: "empty" });
  assert.deepEqual(checkRecipient("   ", SELF), { state: "empty" });
  assert.deepEqual(checkRecipient("qo", SELF), { state: "typing" });
  assert.deepEqual(checkRecipient(OTHER.slice(0, 20), SELF), { state: "typing" });
  assert.deepEqual(checkRecipient(OTHER.slice(0, 20), SELF, true), { state: "invalid", message: SEND_COPY.invalid_recipient });
  assert.deepEqual(checkRecipient("0xabc", SELF), { state: "invalid", message: SEND_COPY.invalid_recipient });
  assert.deepEqual(checkRecipient(corrupt(OTHER), SELF), { state: "invalid", message: SEND_COPY.invalid_recipient });
  assert.deepEqual(checkRecipient(CONTRACT, SELF), { state: "invalid", message: SEND_COPY.invalid_recipient });
  assert.deepEqual(checkRecipient(`  ${OTHER} `, SELF), { state: "ok", address: OTHER });
  assert.deepEqual(checkRecipient(OTHER.toUpperCase(), SELF), { state: "ok", address: OTHER });
  assert.deepEqual(checkRecipient(SELF, SELF), { state: "self", message: SEND_COPY.self_send });
  assert.deepEqual(checkRecipient(SELF.toUpperCase(), SELF), { state: "self", message: SEND_COPY.self_send });
});

test("sends only QOR and converted ERC-20 bank tokens", () => {
  assert.equal(isSendableDenom("uqor"), true);
  assert.equal(isSendableDenom(`erc20:0x${"aB".repeat(20)}`), true);
  assert.equal(isSendableDenom("erc20:0x1234"), false);
  assert.equal(isSendableDenom("amm/pool/1"), false);
  assert.equal(isSendableDenom("ibc/ABC"), false);
});

test("Max keeps 0.1 QOR back for the network fee, and nothing back for other tokens", () => {
  assert.equal(QOR_SEND_RESERVE_UQOR, BigInt(100_000));
  assert.equal(maxSendable("uqor", BigInt(2_000_000)), BigInt(1_900_000));
  assert.equal(maxSendable("uqor", BigInt(100_000)), BigInt(0));
  assert.equal(maxSendable("uqor", BigInt(100)), BigInt(0));
  assert.equal(maxSendable("uqor", BigInt(0)), BigInt(0));
  assert.equal(maxSendable("erc20:0xabc", BigInt(42)), BigInt(42));
  assert.equal(maxSendable("erc20:0xabc", BigInt(-1)), BigInt(0));
});

test("writes a base amount back as a plain decimal", () => {
  assert.equal(baseToInput(BigInt(1_500_000), 6), "1.5");
  assert.equal(baseToInput(BigInt(1), 6), "0.000001");
  assert.equal(baseToInput(BigInt(10) ** BigInt(18) * BigInt(12), 18), "12");
  assert.equal(baseToInput(BigInt(7), 0), "7");
  assert.equal(baseToInput(BigInt(0), 6), "0");
});

test("checks the amount against the balance with fixed copy", () => {
  const balance = BigInt(3_000_000);
  assert.deepEqual(checkSendAmount("", 6, "uqor", balance, "QOR"), { state: "empty" });
  assert.deepEqual(checkSendAmount("1", 6, "uqor", balance, "QOR"), { state: "ok", amount: "1000000", tight: false });
  assert.deepEqual(checkSendAmount("2.95", 6, "uqor", balance, "QOR"), { state: "ok", amount: "2950000", tight: true });
  assert.deepEqual(checkSendAmount("3.1", 6, "uqor", balance, "QOR"), { state: "too_much", message: "You hold less QOR than that." });
  assert.deepEqual(checkSendAmount("0", 6, "uqor", balance, "QOR"), { state: "invalid", message: SEND_COPY.invalid_amount });
  assert.deepEqual(checkSendAmount("abc", 6, "uqor", balance, "QOR"), { state: "invalid", message: SEND_COPY.invalid_amount });
  assert.deepEqual(checkSendAmount("1.0000001", 6, "uqor", balance, "QOR"), { state: "invalid", message: "This token supports up to 6 decimal places." });
  // Other tokens may be sent in full: their fee is paid in QOR.
  assert.deepEqual(checkSendAmount("3", 6, "erc20:0xabc", balance, "QWAKK"), { state: "ok", amount: "3000000", tight: false });
});
