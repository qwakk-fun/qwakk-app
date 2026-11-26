import assert from "node:assert/strict";
import test from "node:test";

import { amm, bank, bytesToBech32 } from "@qorechain/sdk";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";

import { parseNativeActionSwitches } from "../lib/features";
import { SEND_KIND as SEND_KIND_FROM_ACTIONS, encodedMessagesForAction, interfaceFeeInMessages, messagesForAction, parseNativeAction, sendAction as sendActionFromActions } from "../lib/qwakk-native-actions";
import { BANK_SEND_TYPE, checkSend, heldDenom, isAllowedSend, isQoreAccountAddress } from "../lib/qwakk-native-send";
import { balanceShortfall, classifySimulationError, encodeAsAny, isAllowedMessageSet, requiredSpend, toWalletMessages } from "../lib/qwakk-native-tx";
import { SEND_KIND, isSendableDenom, sendAction } from "../lib/qwakk-send-action";
import { SEND_COPY, SIMULATION_FAILURE_COPY, chainFailureCopy } from "../lib/qwakk-tx-copy";

const SENDER = "qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp";
const TREASURY = "qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq";
const RECIPIENT = bytesToBech32(new Uint8Array(20).fill(7), "qor");
/** QWAKK on QoreChain Diana, spelled exactly as the chain reports the balance. */
const QWAKK = "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";
const FEE_OFF = { enabled: false as const, feeBps: 0 };
const FEE_ON = { enabled: true as const, recipient: TREASURY, feeBps: 10 };

const base64ToBytes = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

test("the send action keeps the shape the Send sheet calls run() with", () => {
  assert.equal(SEND_KIND, "send");
  assert.equal(SEND_KIND_FROM_ACTIONS, SEND_KIND);
  assert.equal(sendActionFromActions, sendAction);
  assert.deepEqual(sendAction({ toAddress: ` ${RECIPIENT} `, denom: QWAKK, amount: "5000000" }), { kind: "send", toAddress: RECIPIENT, denom: QWAKK, amount: "5000000" });
  // A sender or extra coins in the client body are dropped by the parser.
  const parsed = parseNativeAction({ kind: "send", toAddress: RECIPIENT, denom: QWAKK, amount: "5000000", fromAddress: TREASURY, sender: TREASURY, amounts: [{ denom: "uqor", amount: "1" }] });
  assert.deepEqual(parsed, { kind: "send", toAddress: RECIPIENT, denom: QWAKK, amount: "5000000" });
});

test("a valid send encodes exactly one MsgSend from the connected sender", () => {
  for (const denom of ["uqor", QWAKK]) {
    const encoded = encodedMessagesForAction(SENDER, parseNativeAction({ kind: "send", toAddress: RECIPIENT, denom, amount: "0012500000" }), FEE_ON);
    assert.equal(encoded.length, 1);
    const [message] = toWalletMessages(encoded);
    assert.equal(message.typeUrl, BANK_SEND_TYPE);
    const decoded = MsgSend.decode(base64ToBytes(message.value));
    assert.equal(decoded.fromAddress, SENDER);
    assert.equal(decoded.toAddress, RECIPIENT);
    // One coin, leading zeros dropped, no interface fee leg even with a treasury configured.
    assert.deepEqual(decoded.amount.map((coin) => ({ denom: coin.denom, amount: coin.amount })), [{ denom, amount: "12500000" }]);
    assert.equal(isAllowedSend(encoded, SENDER, { toAddress: RECIPIENT, denom, amount: "12500000" }), true);
  }
  // The sender is the server's connected address, whatever account is passed in.
  const other = encodedMessagesForAction(TREASURY, sendAction({ toAddress: RECIPIENT, denom: "uqor", amount: "1" }), FEE_OFF);
  assert.equal(MsgSend.decode(other[0].value).fromAddress, TREASURY);
  // The AMM builder never builds a send.
  assert.throws(() => messagesForAction(SENDER, sendAction({ toAddress: RECIPIENT, denom: "uqor", amount: "1" }), FEE_OFF), /encodedMessagesForAction/);
});

test("refuses bad recipients with fixed copy", () => {
  const contract = bytesToBech32(new Uint8Array(32).fill(1), "qor");
  const cosmos = bytesToBech32(new Uint8Array(20).fill(7), "cosmos");
  const badChecksum = `${RECIPIENT.slice(0, -1)}${RECIPIENT.endsWith("q") ? "p" : "q"}`;
  for (const toAddress of ["", "qor1short", badChecksum, RECIPIENT.toUpperCase(), contract, cosmos, "0x6fEFdEA7209797c116747450b12695AccbE81133", ` ${RECIPIENT}x`]) {
    assert.throws(() => encodedMessagesForAction(SENDER, { kind: "send", toAddress, denom: "uqor", amount: "1" }, FEE_OFF), { message: SEND_COPY.invalid_recipient }, toAddress);
  }
  assert.equal(isQoreAccountAddress(RECIPIENT), true);
  assert.equal(isQoreAccountAddress(contract), false);
  assert.throws(() => encodedMessagesForAction(SENDER, { kind: "send", toAddress: SENDER, denom: "uqor", amount: "1" }, FEE_OFF), { message: SEND_COPY.self_send });
  // A sender that is not a connected qor1 account never builds anything.
  assert.throws(() => encodedMessagesForAction("qor1notreal", { kind: "send", toAddress: RECIPIENT, denom: "uqor", amount: "1" }, FEE_OFF), /Connect a QoreChain wallet/);
});

test("refuses zero, negative, fractional and oversized amounts", () => {
  const u128 = ((BigInt(1) << BigInt(128)) - BigInt(1)).toString();
  for (const amount of ["", "0", "000", "-1", "1.5", "1e6", " 1", "abc", "0x10", (BigInt(u128) + BigInt(1)).toString(), "1".repeat(40)]) {
    assert.throws(() => checkSend(SENDER, { toAddress: RECIPIENT, denom: "uqor", amount }), { message: SEND_COPY.invalid_amount }, amount);
  }
  assert.equal(checkSend(SENDER, { toAddress: RECIPIENT, denom: "uqor", amount: u128 }).amount, u128);
});

test("sends only QOR and converted ERC-20 bank denoms", () => {
  for (const denom of ["", "QOR", "UQOR", "uatom", "amm/lp/1", "lp/1", "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", "factory/qor1x/coin", "erc20:0x123", "erc20:a5b3c3Fb92E2E89555F9909b9004C65F3542eE23", `${QWAKK}0`, `erc20:0x${"g".repeat(40)}`]) {
    assert.equal(isSendableDenom(denom), false, denom);
    assert.throws(() => encodedMessagesForAction(SENDER, { kind: "send", toAddress: RECIPIENT, denom, amount: "1" }, FEE_OFF), { message: SEND_COPY.invalid_denom }, denom);
  }
  assert.equal(isSendableDenom("uqor"), true);
  assert.equal(isSendableDenom(QWAKK), true);
  assert.equal(isSendableDenom(QWAKK.toLowerCase()), true);
});

test("sends the denom exactly as the wallet's balance spells it", () => {
  const balances = new Map([[QWAKK, BigInt(3)], ["uqor", BigInt(5)]]);
  assert.equal(heldDenom(balances, QWAKK), QWAKK);
  // Diana refuses the lower-case spelling as an empty balance (simulated 2026-11-26).
  assert.equal(heldDenom(balances, QWAKK.toLowerCase()), QWAKK);
  assert.equal(heldDenom(balances, "erc20:0x0000000000000000000000000000000000000001"), null);
});

test("the send allow-list accepts only the one transfer the server built", () => {
  const expected = { toAddress: RECIPIENT, denom: QWAKK, amount: "10" };
  const good = encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: RECIPIENT, amount: [{ denom: QWAKK, amount: "10" }] })]);
  assert.equal(isAllowedSend(good, SENDER, expected), true);
  const variants = [
    bank.send({ fromAddress: SENDER, toAddress: TREASURY, amount: [{ denom: QWAKK, amount: "10" }] }),
    bank.send({ fromAddress: TREASURY, toAddress: RECIPIENT, amount: [{ denom: QWAKK, amount: "10" }] }),
    bank.send({ fromAddress: SENDER, toAddress: RECIPIENT, amount: [{ denom: QWAKK, amount: "11" }] }),
    bank.send({ fromAddress: SENDER, toAddress: RECIPIENT, amount: [{ denom: "uqor", amount: "10" }] }),
    bank.send({ fromAddress: SENDER, toAddress: RECIPIENT, amount: [{ denom: QWAKK, amount: "10" }, { denom: "uqor", amount: "1" }] }),
  ];
  for (const variant of variants) assert.equal(isAllowedSend(encodeAsAny([variant]), SENDER, expected), false);
  assert.equal(isAllowedSend([...good, ...good], SENDER, expected), false);
  assert.equal(isAllowedSend([...good, ...encodeAsAny([amm.swapExactIn({ sender: SENDER, poolId: "1", tokenIn: { denom: "uqor", amount: "1" }, denomOut: QWAKK, minOut: "1" })])], SENDER, expected), false);
  assert.equal(isAllowedSend([], SENDER, expected), false);
  // A self-send never passes, even when the message matches.
  const self = encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: SENDER, amount: [{ denom: QWAKK, amount: "10" }] })]);
  assert.equal(isAllowedSend(self, SENDER, { ...expected, toAddress: SENDER }), false);
});

test("the swap allow-list is not loosened by sends", () => {
  const send = encodedMessagesForAction(SENDER, sendAction({ toAddress: RECIPIENT, denom: "uqor", amount: "1000" }), FEE_OFF);
  // A lone transfer is never an AMM message set, to the treasury or anyone else.
  assert.equal(isAllowedMessageSet(send, SENDER, TREASURY), false);
  assert.equal(isAllowedMessageSet(encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: TREASURY, amount: [{ denom: "uqor", amount: "1" }] })]), SENDER, TREASURY), false);
  // A swap with a transfer to anyone but the treasury is still refused.
  const swap = amm.swapExactIn({ sender: SENDER, poolId: "1", tokenIn: { denom: "uqor", amount: "999000" }, denomOut: QWAKK, minOut: "1" });
  assert.equal(isAllowedMessageSet(encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: RECIPIENT, amount: [{ denom: "uqor", amount: "1000" }] }), swap]), SENDER, TREASURY), false);
  assert.equal(isAllowedMessageSet(encodeAsAny([bank.send({ fromAddress: SENDER, toAddress: TREASURY, amount: [{ denom: "uqor", amount: "1000" }] }), swap]), SENDER, TREASURY), true);
  // The swap path itself still builds only the treasury fee transfer.
  const swapSet = encodedMessagesForAction(SENDER, parseNativeAction({ kind: "swap", poolId: "1", denomIn: "uqor", amountIn: "1000000", denomOut: QWAKK, minOut: "1" }), FEE_ON);
  assert.equal(MsgSend.decode(swapSet[0].value).toAddress, TREASURY);
});

test("a send carries no interface fee, even to the treasury", () => {
  for (const toAddress of [RECIPIENT, TREASURY]) {
    for (const fee of [FEE_OFF, FEE_ON]) {
      const encoded = encodedMessagesForAction(SENDER, sendAction({ toAddress, denom: "uqor", amount: "5000000" }), fee);
      assert.equal(interfaceFeeInMessages(encoded), null);
    }
  }
  // A swap still discloses its fee leg.
  const swapSet = encodedMessagesForAction(SENDER, parseNativeAction({ kind: "swap", poolId: "1", denomIn: "uqor", amountIn: "1000000", denomOut: QWAKK, minOut: "1" }), FEE_ON);
  assert.deepEqual(interfaceFeeInMessages(swapSet), { denom: "uqor", amount: "1000" });
});

test("the balance check counts the transfer and the network fee", () => {
  const encoded = encodedMessagesForAction(SENDER, sendAction({ toAddress: RECIPIENT, denom: "uqor", amount: "1000000" }), FEE_OFF);
  const spend = requiredSpend(encoded);
  assert.deepEqual([...spend], [["uqor", BigInt(1000000)]]);
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(1_041_000)]]), BigInt(40_895)), null);
  // Sending every QOR leaves nothing for the network fee.
  assert.equal(balanceShortfall(spend, new Map([["uqor", BigInt(1_000_000)]]), BigInt(40_895)), "network_fee");
  const token = requiredSpend(encodedMessagesForAction(SENDER, sendAction({ toAddress: RECIPIENT, denom: QWAKK, amount: "7" }), FEE_OFF));
  assert.equal(balanceShortfall(token, new Map([[QWAKK, BigInt(6)], ["uqor", BigInt(1_000_000)]]), BigInt(40_895)), "insufficient_funds");
});

test("maps bank refusals of a send to fixed copy", () => {
  // Exact text Diana returned when simulating a send to the fee collector module account (2026-11-26).
  assert.equal(classifySimulationError("failed to execute message; message index: 0: qor17xpfvakm2amg962yls6f84z3kell8c5lyj5r7l is not allowed to receive funds: unauthorized [cosmos/cosmos-sdk@v0.53.8/x/bank/keeper/msg_server.go:62] with gas used: '116130'"), "send_recipient_blocked");
  assert.equal(classifySimulationError("failed to execute message; message index: 0: spendable balance 0erc20:0xa5b3 is smaller than 1erc20:0xa5b3: insufficient funds"), "insufficient_funds");
  assert.equal(classifySimulationError("erc20:0xabc transfers are currently disabled: send transactions are disabled"), "send_disabled");
  assert.equal(chainFailureCopy("bank", 5), SIMULATION_FAILURE_COPY.send_disabled);
  for (const line of [...Object.values(SEND_COPY), SIMULATION_FAILURE_COPY.send_recipient_blocked, SIMULATION_FAILURE_COPY.send_disabled]) {
    assert.equal(line.includes("\u2014"), false, line);
    assert.ok(line.length > 0);
  }
});

test("send is its own action switch and never part of enabled", () => {
  assert.equal(parseNativeActionSwitches("enabled").actions.send, false);
  assert.equal(parseNativeActionSwitches("all").actions.send, false);
  assert.equal(parseNativeActionSwitches("swap,liquidity").actions.send, false);
  assert.equal(parseNativeActionSwitches("send").actions.send, true);
  assert.equal(parseNativeActionSwitches("send").actions.swap, false);
  assert.deepEqual(parseNativeActionSwitches("swap,liquidity,create_pool,send").actions, { swap: true, add_liquidity: true, remove_liquidity: true, create_pool: true, rewards_claim: false, send: true });
});
