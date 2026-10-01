import assert from "node:assert/strict";
import test from "node:test";

import { bank, qorechainRegistry } from "@qorechain/sdk";
import { TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";

import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit } from "../lib/qora-liquidity-math";
import { messagesForAction, parseNativeAction } from "../lib/qora-native-actions";
import { classifySimulationError, feeForSimulatedGas, isRelayableBody } from "../lib/qora-native-tx";

const sender = "qor1exampleaddress000000000000";
const treasury = "qor1treasuryaddress0000000000000";
const noFee = { enabled: false as const, feeBps: 5 };
const withFee = { enabled: true as const, recipient: treasury, feeBps: 5 };

function body(messages: ReturnType<typeof messagesForAction>) {
  const registry = qorechainRegistry();
  return TxBody.encode(TxBody.fromPartial({ messages: messages.map((message) => registry.encodeAsAny(message)) })).finish();
}

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

test("rejects unknown actions and same-token swaps", () => {
  assert.throws(() => parseNativeAction({ kind: "send" }), /supported action/);
  assert.throws(() => messagesForAction(sender, { ...swap, denomOut: "uqor" } as typeof swap, noFee), /different/);
  assert.throws(() => messagesForAction(sender, parseNativeAction({ kind: "create_pool", poolType: "stable_swap", denomA: "uqor", amountA: "1", denomB: "utest", amountB: "1", amplificationCoefficient: 6000 }), noFee), /amplification/);
});

test("relays AMM bodies and only the treasury fee transfer next to a swap", () => {
  assert.equal(isRelayableBody(body(messagesForAction(sender, swap, noFee))), true);
  assert.equal(isRelayableBody(body(messagesForAction(sender, swap, withFee)), treasury), true);
  // The same fee body is refused when the server has no treasury configured.
  assert.equal(isRelayableBody(body(messagesForAction(sender, swap, withFee))), false);
  const strayTransfer = [bank.send({ fromAddress: sender, toAddress: "qor1someoneelse00000000000000000", amount: [{ denom: "uqor", amount: "1" }] }), ...messagesForAction(sender, swap, noFee)];
  assert.equal(isRelayableBody(body(strayTransfer), treasury), false);
  const transferOnly = [bank.send({ fromAddress: sender, toAddress: treasury, amount: [{ denom: "uqor", amount: "1" }] })];
  assert.equal(isRelayableBody(body(transferOnly), treasury), false);
});

test("prices simulated gas with margin and headroom", () => {
  const fee = feeForSimulatedGas(BigInt(100_000));
  assert.equal(fee.gas, "210000");
  assert.deepEqual(fee.amount, [{ denom: "uqor", amount: "31500" }]);
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
