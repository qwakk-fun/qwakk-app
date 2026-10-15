import assert from "node:assert/strict";
import test from "node:test";

import { bank, qorechainRegistry } from "@qorechain/sdk";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";

import { getServerQwakkFeeConfig } from "../lib/qwakk-fee-config";
import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit } from "../lib/qwakk-liquidity-math";
import { encodedMessagesForAction, interfaceFeeInMessages, messagesForAction, parseNativeAction } from "../lib/qwakk-native-actions";
import { classifySimulationError, encodeAsAny, isAllowedMessageSet, toWalletMessages } from "../lib/qwakk-native-tx";

const sender = "qor1exampleaddress000000000000";
const treasury = "qor1treasuryaddress0000000000000";
const noFee = { enabled: false as const, feeBps: 5 };
const withFee = { enabled: true as const, recipient: treasury, feeBps: 5 };


const base64ToBytes = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

const swap = parseNativeAction({ kind: "swap", poolId: "1", denomIn: "uqor", amountIn: "1000000", denomOut: "utest", minOut: "900" });

test("builds a single native swap when no interface fee is configured", () => {
  assert.deepEqual(messagesForAction(sender, swap, noFee).map((message) => message.typeUrl), ["/qorechain.amm.v1.MsgSwapExactIn"]);
});

test("adds the disclosed fee transfer before the swap when a treasury is set", () => {
  assert.deepEqual(messagesForAction(sender, swap, withFee).map((message) => message.typeUrl), ["/cosmos.bank.v1beta1.MsgSend", "/qorechain.amm.v1.MsgSwapExactIn"]);
});

test("builds pool and liquidity messages", () => {
  const create = parseNativeAction({ kind: "create_pool", poolType: "constant_product", denomA: "uqor", amountA: "5000000", denomB: "utest", amountB: "5000000" });
  const add = parseNativeAction({ kind: "add_liquidity", poolId: "1", denomA: "uqor", amountA: "100", denomB: "utest", amountB: "100", minLpOut: "90" });
  const remove = parseNativeAction({ kind: "remove_liquidity", poolId: "1", lpAmount: "50", minAmountA: "1", minAmountB: "1" });
  assert.equal(messagesForAction(sender, create, noFee)[0].typeUrl, "/qorechain.amm.v1.MsgCreatePool");
  assert.equal(messagesForAction(sender, add, noFee)[0].typeUrl, "/qorechain.amm.v1.MsgAddLiquidity");
  assert.equal(messagesForAction(sender, remove, noFee)[0].typeUrl, "/qorechain.amm.v1.MsgRemoveLiquidity");
});

test("never builds a swap without a minimum output", () => {
  const unprotected = { ...swap, minOut: "0" };
  assert.throws(() => messagesForAction(sender, unprotected, noFee), /minimum output/);
  assert.throws(() => messagesForAction(sender, unprotected, withFee), /minimum output/);
});

test("rejects unknown actions and same-token swaps", () => {
  assert.throws(() => parseNativeAction({ kind: "send" }), /supported action/);
  assert.throws(() => messagesForAction(sender, { ...swap, denomOut: "uqor" } as typeof swap, noFee), /different/);
  assert.throws(() => messagesForAction(sender, parseNativeAction({ kind: "create_pool", poolType: "stable_swap", denomA: "uqor", amountA: "1", denomB: "utest", amountB: "1", amplificationCoefficient: 6000 }), noFee), /amplification/);
});

test("only lets AMM messages and the sender's treasury fee transfer reach the wallet", () => {
  assert.equal(isAllowedMessageSet(encodeAsAny(messagesForAction(sender, swap, noFee)), sender), true);
  assert.equal(isAllowedMessageSet(encodeAsAny(messagesForAction(sender, swap, withFee)), sender, treasury), true);
  // The same fee set is refused when the server has no treasury configured.
  assert.equal(isAllowedMessageSet(encodeAsAny(messagesForAction(sender, swap, withFee)), sender), false);
  const strayTransfer = [bank.send({ fromAddress: sender, toAddress: "qor1someoneelse00000000000000000", amount: [{ denom: "uqor", amount: "1" }] }), ...messagesForAction(sender, swap, noFee)];
  assert.equal(isAllowedMessageSet(encodeAsAny(strayTransfer), sender, treasury), false);
  const transferOnly = [bank.send({ fromAddress: sender, toAddress: treasury, amount: [{ denom: "uqor", amount: "1" }] })];
  assert.equal(isAllowedMessageSet(encodeAsAny(transferOnly), sender, treasury), false);
  const otherPayer = [bank.send({ fromAddress: "qor1someoneelse00000000000000000", toAddress: treasury, amount: [{ denom: "uqor", amount: "1" }] }), ...messagesForAction(sender, swap, noFee)];
  assert.equal(isAllowedMessageSet(encodeAsAny(otherPayer), sender, treasury), false);
  assert.equal(isAllowedMessageSet([], sender, treasury), false);
});

test("encodes the swap with the fee leg at the configured bps, paid by the sender to the treasury", () => {
  const fee = { enabled: true as const, recipient: treasury, feeBps: 10 };
  const messages = toWalletMessages(encodedMessagesForAction(sender, swap, fee));
  assert.deepEqual(messages.map((message) => message.typeUrl), ["/cosmos.bank.v1beta1.MsgSend", "/qorechain.amm.v1.MsgSwapExactIn"]);

  const send = MsgSend.decode(base64ToBytes(messages[0].value));
  assert.equal(send.fromAddress, sender);
  assert.equal(send.toAddress, treasury);
  // 1,000,000 uqor at 10 bps is 1,000 uqor, integer math.
  assert.deepEqual(send.amount.map((coin) => ({ denom: coin.denom, amount: coin.amount })), [{ denom: "uqor", amount: "1000" }]);

  const swapMessage = qorechainRegistry().decode({ typeUrl: messages[1].typeUrl, value: base64ToBytes(messages[1].value) });
  assert.equal(swapMessage.sender, sender);
  assert.equal(swapMessage.tokenIn.amount, "999000");
  assert.equal(swapMessage.minOut, "900");
});

test("discloses exactly the fee transfer QoreX will sign", () => {
  assert.deepEqual(interfaceFeeInMessages(encodedMessagesForAction(sender, swap, { enabled: true, recipient: treasury, feeBps: 10 })), { denom: "uqor", amount: "1000" });
  assert.equal(interfaceFeeInMessages(encodedMessagesForAction(sender, swap, noFee)), null);
  // A zero-bps fee adds no transfer at all.
  assert.equal(interfaceFeeInMessages(encodedMessagesForAction(sender, swap, { enabled: true, recipient: treasury, feeBps: 0 })), null);
});

test("never builds a fee above the 30 bps cap", () => {
  assert.throws(() => encodedMessagesForAction(sender, swap, { enabled: true, recipient: treasury, feeBps: 31 }), /between 0 and 30 bps/);
  const atCap = toWalletMessages(encodedMessagesForAction(sender, swap, { enabled: true, recipient: treasury, feeBps: 30 }));
  assert.equal(MsgSend.decode(base64ToBytes(atCap[0].value)).amount[0].amount, "3000");
});

test("reads the fee from server configuration and falls back when it is above the cap", () => {
  const saved = { bps: process.env.QWAKK_SWAP_FEE_BPS, treasury: process.env.QWAKK_TREASURY_ADDRESS };
  try {
    process.env.QWAKK_TREASURY_ADDRESS = treasury;
    process.env.QWAKK_SWAP_FEE_BPS = "50";
    assert.deepEqual(getServerQwakkFeeConfig(), { enabled: true, recipient: treasury, feeBps: 10 });
    process.env.QWAKK_SWAP_FEE_BPS = "30";
    assert.deepEqual(getServerQwakkFeeConfig(), { enabled: true, recipient: treasury, feeBps: 30 });
    process.env.QWAKK_TREASURY_ADDRESS = "0xnotaqoraddress";
    assert.equal(getServerQwakkFeeConfig().enabled, false);
  } finally {
    if (saved.bps === undefined) delete process.env.QWAKK_SWAP_FEE_BPS; else process.env.QWAKK_SWAP_FEE_BPS = saved.bps;
    if (saved.treasury === undefined) delete process.env.QWAKK_TREASURY_ADDRESS; else process.env.QWAKK_TREASURY_ADDRESS = saved.treasury;
  }
});

test("uses the connected address as sender for every action", () => {
  const create = parseNativeAction({ kind: "create_pool", poolType: "constant_product", denomA: "uqor", amountA: "5000000", denomB: "utest", amountB: "5000000" });
  const [encoded] = encodedMessagesForAction(sender, create, noFee);
  assert.equal(qorechainRegistry().decode(encoded).creator, sender);
});

test("maps chain errors to fixed reasons", () => {
  assert.equal(classifySimulationError("spendable balance 0uprobe is smaller than 1000000uprobe: insufficient funds"), "insufficient_funds");
  assert.equal(classifySimulationError("failed to execute message; message index: 0: pool not found"), "pool_not_found");
  assert.equal(classifySimulationError("slippage tolerance exceeded"), "price_moved");
  assert.equal(classifySimulationError("something unexpected"), "rejected");
});

test("derives liquidity minimums with integer math", () => {
  assert.equal(matchingDeposit("100", "1000", "4000"), "400");
  assert.equal(expectedLpForDeposit("100", "400", "1000", "4000", "2000"), "200");
  assert.equal(expectedLpForDeposit("100", "300", "1000", "4000", "2000"), "150");
  assert.deepEqual(expectedWithdrawal("500", "1000", "4000", "2000"), { amountA: "250", amountB: "1000" });
  assert.equal(expectedWithdrawal("3000", "1000", "4000", "2000"), null);
  assert.equal(applySlippage("200", 50), "199");
});
