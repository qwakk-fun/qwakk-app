import assert from "node:assert/strict";
import test from "node:test";

import { buildLiquidityRoute } from "../lib/qwakk-liquidity-route";

const sender = "qor1exampleaddress000000000000";

test("builds an unsigned native add-liquidity message", () => {
  const plan = buildLiquidityRoute({
    action: "add",
    sender,
    poolId: "1",
    denomA: "uqor",
    amountA: "1000000",
    denomB: "utest",
    amountB: "2000000",
    minLpOut: "0",
  });
  assert.equal(plan.message.typeUrl, "/qorechain.amm.v1.MsgAddLiquidity");
});

test("builds an unsigned native remove-liquidity message", () => {
  const plan = buildLiquidityRoute({
    action: "remove",
    sender,
    poolId: "1",
    lpAmount: "500000",
    minAmountA: "1",
    minAmountB: "1",
  });
  assert.equal(plan.message.typeUrl, "/qorechain.amm.v1.MsgRemoveLiquidity");
});

test("rejects invalid liquidity plans", () => {
  assert.throws(() => buildLiquidityRoute({
    action: "add",
    sender,
    poolId: "1",
    denomA: "uqor",
    amountA: "1",
    denomB: "uqor",
    amountB: "1",
    minLpOut: "0",
  }), /different native token denoms/);
});
