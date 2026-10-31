import assert from "node:assert/strict";
import test from "node:test";

import {
  chainImpactBps,
  deviationBps,
  minInputForOutput,
  nextRepriceStep,
  parseTargetRatio,
  planDeposit,
  planReprice,
  planResetDeposit,
  swapOutcome,
} from "../lib/qwakk-reprice";

/** Diana AMM params (`/qorechain/amm/v1/params`, 2026-10-31). */
const params = { swapFeeBps: 30, protocolFeeBps: 10, maxSwapImpactBps: 500 };
/** Diana pool 1 on 2026-10-31: fETH (18 decimals) is the base, uqor the quote. */
const POOL1 = { reserveBase: BigInt(980129), reserveQuote: BigInt(1020319) };
const target3000 = parseTargetRatio("3000", 18, 6);

test("parses a display price into a raw ratio of base units", () => {
  assert.deepEqual(parseTargetRatio("3000", 18, 6), { num: BigInt(3000) * BigInt(10) ** BigInt(6), den: BigInt(10) ** BigInt(18) });
  assert.deepEqual(parseTargetRatio("2.5", 6, 6), { num: BigInt(25) * BigInt(10) ** BigInt(6), den: BigInt(10) ** BigInt(7) });
  assert.throws(() => parseTargetRatio("0", 18, 6));
  assert.throws(() => parseTargetRatio("-1", 18, 6));
  assert.throws(() => parseTargetRatio("1e3", 18, 6));
  // 1,000 QOR and 1 fETH is exactly 1000 QOR per fETH.
  assert.equal(deviationBps(BigInt(10) ** BigInt(18), BigInt(1_000_000_000), parseTargetRatio("1000", 18, 6)), 0);
  assert.equal(deviationBps(BigInt(10) ** BigInt(18), BigInt(1_100_000_000), parseTargetRatio("1000", 18, 6)), 1000);
});

test("matches QoreChain's quote and impact for a live pool 1 input", () => {
  // Diana quote_exact_in for 46000 fETH units on pool 1: amount_out 45608, fee 138, impact_bps 448.
  const outcome = swapOutcome(BigInt(46000), POOL1.reserveBase, POOL1.reserveQuote, params);
  assert.equal(outcome.amountOut, BigInt(45608));
  assert.equal(outcome.fee, BigInt(138));
  assert.equal(outcome.impactBps, 448);
  // The simulated amm_swap event for 46001 reported protocol_fee 46, which leaves the pool.
  const next = swapOutcome(BigInt(46001), POOL1.reserveBase, POOL1.reserveQuote, params);
  assert.equal(next.protocolFee, BigInt(46));
  assert.equal(next.reserveInAfter, POOL1.reserveBase + BigInt(46001) - BigInt(46));
  assert.equal(chainImpactBps(BigInt(0), BigInt(0), BigInt(1), BigInt(1)), 10_000);
});

test("uses the smallest input that still returns k", () => {
  for (const [k, rIn, rOut] of [[2, 18_000_000_000, 56], [45_868, 980_129, 1_020_319], [1, 5, 1_000_000_000_000]] as const) {
    const input = minInputForOutput(BigInt(k), BigInt(rIn), BigInt(rOut), 30);
    assert.ok(input !== null);
    assert.ok(swapOutcome(input, BigInt(rIn), BigInt(rOut), params).amountOut >= BigInt(k));
    assert.ok(swapOutcome(input - BigInt(1), BigInt(rIn), BigInt(rOut), params).amountOut < BigInt(k));
  }
  assert.equal(minInputForOutput(BigInt(0), BigInt(10), BigInt(10), 30), null);
  assert.equal(minInputForOutput(BigInt(10), BigInt(10), BigInt(10), 30), null);
});

test("plans pool 1 to 3000 QOR per fETH with every step under the impact limit", () => {
  const plan = planReprice({ ...POOL1, target: target3000, params, stepImpactBps: 450, toleranceBps: 50, maxSteps: 5_000 });
  assert.equal(plan.direction, "sell_base");
  assert.equal(plan.steps.length, 218);
  assert.equal(plan.stop, "granularity");
  for (const step of plan.steps) {
    assert.ok(step.impactBps <= 450, `step ${step.index} impact ${step.impactBps}`);
    assert.ok(step.amountOut >= BigInt(1));
    assert.equal(step.minOut, step.amountOut);
    // Never past the target.
    assert.ok(step.deviationBpsAfter >= 0, `step ${step.index} overshoots`);
  }
  // The uqor side ends at 56 base units: integer rounding leaves the price 2.53% above target.
  assert.equal(plan.reserveQuote, BigInt(56));
  assert.equal(plan.minReserveQuote, BigInt(56));
  assert.equal(plan.deviationBps, 253);
  assert.equal(plan.totalQuoteOut, POOL1.reserveQuote - BigInt(56));
  // Each step's reserves chain into the next.
  const last = plan.steps[plan.steps.length - 1];
  assert.equal(last.reserveBaseAfter, plan.reserveBase);
});

test("the max-steps cap stops the plan early, and a plan at the target has no steps", () => {
  const capped = planReprice({ ...POOL1, target: target3000, params, stepImpactBps: 450, toleranceBps: 50, maxSteps: 10 });
  assert.equal(capped.steps.length, 10);
  assert.equal(capped.stop, "max_steps");
  const flat = planReprice({ reserveBase: BigInt(10) ** BigInt(18), reserveQuote: BigInt(3_000_000_000), target: target3000, params, stepImpactBps: 450, toleranceBps: 10, maxSteps: 10 });
  assert.equal(flat.steps.length, 0);
  assert.equal(flat.stop, "target");
});

test("sells the quote side when the pool is below the target", () => {
  // 1 fETH against 1000 QOR: 1000 QOR per fETH, target 1100.
  const target = parseTargetRatio("1100", 18, 6);
  const plan = planReprice({ reserveBase: BigInt(10) ** BigInt(18), reserveQuote: BigInt(1_000_000_000), target, params, stepImpactBps: 450, toleranceBps: 10, maxSteps: 50 });
  assert.equal(plan.direction, "sell_quote");
  assert.equal(plan.stop, "target");
  assert.ok(plan.steps.length >= 1 && plan.steps.length <= 3);
  assert.ok(Math.abs(plan.deviationBps) <= 10);
  assert.ok(plan.steps.every((step) => step.deviationBpsAfter <= 0 || Math.abs(step.deviationBpsAfter) <= 10));
});

test("reports when the output reserve is too small to move within the impact limit", () => {
  // 10 units out of reserve: even one unit is 10% impact.
  const next = nextRepriceStep(BigInt(1_000_000), BigInt(10), parseTargetRatio("0.000000000001", 18, 6), params, 450, 10);
  assert.deepEqual(next, { stop: "impact_floor" });
  assert.throws(() => nextRepriceStep(BigInt(1), BigInt(1), target3000, params, 501, 10));
});

test("deposit plans: proportional for a live pool, sqrt for the reset route", () => {
  // After the swaps: 18205449173 fETH units / 56 uqor, LP supply unchanged.
  const deposit = planDeposit(BigInt(3_000_000_000), BigInt(18_205_449_173), BigInt(56), BigInt(1_000_022));
  assert.equal(deposit.baseAmount, BigInt("975291919982142858"));
  assert.equal(deposit.expectedLp, BigInt("53572607142857"));
  assert.ok(deposit.minLp < deposit.expectedLp);
  // Diana keyless simulation: withdraw all, then 100000 uqor + 33333333333333 fETH units minted 1825741858 LP.
  const reset = planResetDeposit(BigInt(100_000), target3000);
  assert.equal(reset.baseAmount, BigInt("33333333333333"));
  assert.equal(reset.expectedLp, BigInt(1_825_741_858));
  assert.equal(planResetDeposit(BigInt(3_000_000_000), target3000).baseAmount, BigInt(10) ** BigInt(18));
});
