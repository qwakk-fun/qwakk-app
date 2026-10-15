import assert from "node:assert/strict";
import test from "node:test";

import { qorechainRegistry } from "@qorechain/sdk";

import { formatRatio, initialLpShares, isqrt } from "../lib/qwakk-amm-math";
import { applySlippage, expectedLpForDeposit, expectedWithdrawal, matchingDeposit, poolShareBps, withinTolerance } from "../lib/qwakk-liquidity-math";
import { alignDepositToPool, buildLiquidityRoute } from "../lib/qwakk-liquidity-route";
import { buildCreatePoolPlan, createPoolPrecheck, sortDeposits } from "../lib/qwakk-pool-route";
import { encodeAsAny } from "../lib/qwakk-native-tx";

const sender = "qor1exampleaddress000000000000";
const registry = qorechainRegistry();
const decode = (message: { typeUrl: string; value: unknown }) => registry.decode(encodeAsAny([message as never])[0]);

/** 1,000 QOR against 2,500 TEST, LP supply floor(sqrt(1e9 * 2.5e9)). */
const RA = "1000000000";
const RB = "2500000000";
const SUPPLY = "1581138830";

test("builds an unsigned native add-liquidity message with every field intact", () => {
  const plan = buildLiquidityRoute({
    action: "add",
    sender,
    poolId: "1",
    denomA: "uqor",
    amountA: "100000000",
    denomB: "utest",
    amountB: "250000000",
    minLpOut: "157320280",
  });
  assert.equal(plan.message.typeUrl, "/qorechain.amm.v1.MsgAddLiquidity");
  const decoded = decode(plan.message);
  assert.equal(decoded.sender, sender);
  assert.equal(decoded.poolId.toString(), "1");
  assert.deepEqual({ denom: decoded.amountA.denom, amount: decoded.amountA.amount }, { denom: "uqor", amount: "100000000" });
  assert.deepEqual({ denom: decoded.amountB.denom, amount: decoded.amountB.amount }, { denom: "utest", amount: "250000000" });
  assert.equal(decoded.minLpOut, "157320280");
});

test("builds an unsigned native remove-liquidity message with every field intact", () => {
  const plan = buildLiquidityRoute({
    action: "remove",
    sender,
    poolId: "1",
    lpAmount: "500000",
    minAmountA: "314",
    minAmountB: "786",
  });
  assert.equal(plan.message.typeUrl, "/qorechain.amm.v1.MsgRemoveLiquidity");
  const decoded = decode(plan.message);
  assert.equal(decoded.lpAmount, "500000");
  assert.equal(decoded.minAmountA, "314");
  assert.equal(decoded.minAmountB, "786");
});

test("rejects invalid liquidity plans, including ones without protection", () => {
  assert.throws(() => buildLiquidityRoute({
    action: "add",
    sender,
    poolId: "1",
    denomA: "uqor",
    amountA: "1",
    denomB: "uqor",
    amountB: "1",
    minLpOut: "1",
  }), /different native token denoms/);
  // The chain accepts min_lp_out 0, which protects nothing. Qwakk never sends it.
  assert.throws(() => buildLiquidityRoute({ action: "add", sender, poolId: "1", denomA: "uqor", amountA: "10", denomB: "utest", amountB: "25", minLpOut: "0" }), /too small/);
  assert.throws(() => buildLiquidityRoute({ action: "remove", sender, poolId: "1", lpAmount: "5", minAmountA: "0", minAmountB: "0" }), /too small/);
  assert.throws(() => buildLiquidityRoute({ action: "remove", sender, poolId: "0", lpAmount: "5", minAmountA: "1", minAmountB: "1" }), /pool ID/);
});

test("fills the counterpart deposit at the pool ratio from either side", () => {
  // 100 QOR needs 250 TEST; 250 TEST needs 100 QOR.
  assert.equal(matchingDeposit("100000000", RA, RB), "250000000");
  assert.equal(matchingDeposit("250000000", RB, RA), "100000000");
  // Rounded down: 1 uqor of a 1:2.5 pool matches 2 utest, never 3.
  assert.equal(matchingDeposit("1", RA, RB), "2");
  assert.equal(matchingDeposit("1", "0", RB), null);
});

test("expects LP shares as the smaller proportional share, rounded down", () => {
  // 10% of each reserve mints 10% of supply.
  assert.equal(expectedLpForDeposit("100000000", "250000000", RA, RB, SUPPLY), "158113883");
  // An off-ratio deposit is credited only for its smaller side.
  assert.equal(expectedLpForDeposit("100000000", "200000000", RA, RB, SUPPLY), "126491106");
  assert.equal(expectedLpForDeposit("1", "1", "0", RB, SUPPLY), null);
  assert.equal(applySlippage("158113883", 50), "157323313");
  assert.equal(poolShareBps("158113883", SUPPLY), 909);
});

test("pays a withdrawal out pro rata, rounded down", () => {
  assert.deepEqual(expectedWithdrawal("158113883", RA, RB, SUPPLY), { amountA: "100000000", amountB: "250000000" });
  // One share less rounds both sides down.
  assert.deepEqual(expectedWithdrawal("158113882", RA, RB, SUPPLY), { amountA: "99999999", amountB: "249999998" });
  assert.deepEqual(expectedWithdrawal(SUPPLY, RA, RB, SUPPLY), { amountA: RA, amountB: RB });
  assert.equal(expectedWithdrawal("1581138831", RA, RB, SUPPLY), null);
  assert.deepEqual(expectedWithdrawal("500", "1000", "4000", "2000"), { amountA: "250", amountB: "1000" });
});

test("tolerates rounding but not a moved pool ratio", () => {
  assert.equal(withinTolerance("250000000", "250000001", 50), true);
  assert.equal(withinTolerance("248750000", "250000000", 50), true);
  assert.equal(withinTolerance("248749999", "250000000", 50), false);
  assert.equal(withinTolerance("3", "2", 50), true);
});

test("puts a deposit in the pool's token order", () => {
  const deposit = { kind: "add_liquidity" as const, poolId: "1", denomA: "utest", amountA: "250", denomB: "uqor", amountB: "100", minLpOut: "1" };
  assert.deepEqual(alignDepositToPool(deposit, { tokenA: "uqor", tokenB: "utest" }), { ...deposit, denomA: "uqor", amountA: "100", denomB: "utest", amountB: "250" });
  assert.equal(alignDepositToPool(deposit, { tokenA: "uqor", tokenB: "uother" }), null);
});

test("orders new-pool deposits the way the chain stores them", () => {
  assert.deepEqual(sortDeposits({ denom: "uzzz", amount: "5" }, { denom: "uqor", amount: "7" }), [{ denom: "uqor", amount: "7" }, { denom: "uzzz", amount: "5" }]);
  // Byte order: "ibc/..." sorts before "uqor".
  assert.deepEqual(sortDeposits({ denom: "uqor", amount: "1" }, { denom: "ibc/ABC", amount: "2" }).map((coin) => coin.denom), ["ibc/ABC", "uqor"]);
  const plan = buildCreatePoolPlan({ creator: sender, poolType: "constant_product", denomA: "uzzz", amountA: "2500000000", denomB: "uqor", amountB: "1000000000" });
  const decoded = decode(plan.message);
  assert.equal(decoded.creator, sender);
  assert.equal(decoded.poolType, "constant_product");
  assert.deepEqual({ denom: decoded.initialDepositA.denom, amount: decoded.initialDepositA.amount }, { denom: "uqor", amount: "1000000000" });
  assert.deepEqual({ denom: decoded.initialDepositB.denom, amount: decoded.initialDepositB.amount }, { denom: "uzzz", amount: "2500000000" });
  assert.equal(decoded.amplificationCoefficient, 0);
  const stable = decode(buildCreatePoolPlan({ creator: sender, poolType: "stable_swap", denomA: "uusdc", amountA: "1000000", denomB: "uusdt", amountB: "1000000", amplificationCoefficient: 200 }).message);
  assert.equal(stable.amplificationCoefficient, 200);
});

test("pre-checks min_liquidity per deposit, matching what Diana's keeper accepted", () => {
  const live = { minLiquidity: "1000", enabled: true };
  // Simulated on Diana 2026-10-15: 1000/1000 reaches the bank step; 1000/999 and 999/1000000 do not.
  assert.equal(createPoolPrecheck({ amountA: "1000", amountB: "1000" }, live), null);
  assert.equal(createPoolPrecheck({ amountA: "1000", amountB: "999" }, live), "below_min_liquidity");
  assert.equal(createPoolPrecheck({ amountA: "999", amountB: "1000000" }, live), "below_min_liquidity");
  assert.equal(createPoolPrecheck({ amountA: "100000", amountB: "10" }, live), "below_min_liquidity");
  assert.equal(createPoolPrecheck({ amountA: "1000", amountB: "1000" }, { ...live, enabled: false }), "module_disabled");
});

test("computes initial LP shares and the starting price with integer math", () => {
  // qorechain-core x/amm/types/pool_test.go: 1,000,000 and 2,000,000 hold an LP supply of 1,414,213.
  assert.equal(initialLpShares("1000000", "2000000"), "1414213");
  assert.equal(initialLpShares(RA, RB), SUPPLY);
  assert.equal(isqrt(BigInt(0)), BigInt(0));
  assert.equal(isqrt(BigInt(99)), BigInt(9));
  assert.equal(isqrt(BigInt(10) ** BigInt(36)), BigInt(10) ** BigInt(18));
  assert.equal(formatRatio(RB, 6, RA, 6), "2.5");
  assert.equal(formatRatio(RA, 6, RB, 6), "0.4");
  // A 0-decimal token priced in QOR: 5 base units per 1 QOR.
  assert.equal(formatRatio("5", 0, "1000000", 6), "5");
  assert.equal(formatRatio("1", 6, "3", 6), "0.333333");
  assert.equal(formatRatio("1", 6, "0", 6), null);
});
