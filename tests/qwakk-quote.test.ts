import assert from "node:assert/strict";
import test from "node:test";

import type { AmmParams, AmmPool, ChainQuote } from "../lib/qwakk-amm-chain";
import { classifyQuoteError, parseAmmParams, parseAmmPool } from "../lib/qwakk-amm-chain";
import { constantProductOut, curveImpactBps, maxSwapInForImpact, maxTotalForSwapIn, priceImpactBps } from "../lib/qwakk-amm-math";
import {
  IMPACT_WARN_BPS,
  NETWORK_FEE_RESERVE_UQOR,
  QuoteError,
  buildExactInQuoteRequest,
  buildSwapQuote,
  calculateMinimumOut,
  coversSpend,
  parseSlippagePercent,
  quoteKey,
  requoteDecision,
} from "../lib/qwakk-quote";

const treasury = "qor1treasuryaddress0000000000000";

/** Live Diana params from /qorechain/amm/v1/params, read 2026-10-15. */
const DIANA_PARAMS_JSON = { params: { swap_fee_bps: 30, protocol_fee_bps: 10, min_liquidity: "1000", max_pools_per_creator: 50, lp_token_decimals: 6, pool_creation_fee: "100000000", max_swap_impact_bps: 500, enabled: true } };
const params = parseAmmParams(DIANA_PARAMS_JSON) as AmmParams;

/** A launch-shaped pool: 1,000 QOR against 2,500 TEST (6 decimals), sorted uqor < utest. */
const POOL_JSON = { id: "1", pool_type: "constant_product", creator: "qor1creator", token_a: "uqor", token_b: "utest", reserve_a: "1000000000", reserve_b: "2500000000", lp_supply: "1581138830", lp_denom: "amm-lp/1", created_at: "8000000", status: "active", weighted_avg_price: "2.5", amplification_coefficient: 0 };
const pool = parseAmmPool(POOL_JSON) as AmmPool;

function chainLike(amountIn: string, reserveIn: string, reserveOut: string): ChainQuote {
  return { ok: true, ...constantProductOut(amountIn, reserveIn, reserveOut, 30) };
}

test("parses the live AMM params and pool view", () => {
  assert.deepEqual(params, { swapFeeBps: 30, protocolFeeBps: 10, minLiquidity: "1000", maxPoolsPerCreator: 50, lpTokenDecimals: 6, poolCreationFee: "100000000", maxSwapImpactBps: 500, enabled: true });
  assert.equal(pool.tokenA, "uqor");
  assert.equal(pool.reserveB, "2500000000");
  assert.equal(pool.createdAt, "8000000");
  assert.equal(parseAmmParams({ params: { swap_fee_bps: 30 } }), null);
  assert.equal(parseAmmPool({ id: "1" }), null);
});

test("subtracts the configured interface fee before requesting an AMM quote", () => {
  const quote = buildExactInQuoteRequest({
    poolId: "7",
    denomIn: "uqor",
    amountIn: "1000000",
    slippageBps: 50,
    fee: { enabled: true, recipient: "qor1exampleaddress000000000000", feeBps: 5 },
  });

  assert.equal(quote.interfaceFee, "500");
  assert.equal(quote.swapAmountIn, "999500");
  assert.equal(quote.totalAmountIn, "1000000");
});

test("rounds the interface fee down, in the trader's favour", () => {
  // 1,999 uqor at 10 bps is 1.999 uqor of fee: the trader pays 1.
  const quote = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "1999", fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  assert.equal(quote.interfaceFee, "1");
  assert.equal(quote.swapAmountIn, "1998");
});

test("uses the full input when the interface fee is not configured", () => {
  const quote = buildExactInQuoteRequest({
    poolId: "1",
    denomIn: "ibc/ABC123",
    amountIn: "2500000",
    fee: { enabled: false, feeBps: 5 },
  });

  assert.equal(quote.interfaceFee, "0");
  assert.equal(quote.swapAmountIn, "2500000");
  assert.equal(quote.interfaceFeeEnabled, false);
});

test("calculates minimum output entirely with integer arithmetic, rounded down", () => {
  assert.equal(calculateMinimumOut("1234567", 50), "1228394");
  // 24,654,515 * 0.995 = 24,531,242.425: never rounds up.
  assert.equal(calculateMinimumOut("24654515", 50), "24531242");
  assert.equal(calculateMinimumOut("1", 1), "0");
});

test("rejects invalid quote inputs", () => {
  assert.throws(
    () => buildExactInQuoteRequest({
      poolId: "0",
      denomIn: "uqor",
      amountIn: "100",
      fee: { enabled: false, feeBps: 5 },
    }),
    /valid pool ID/,
  );
  assert.throws(() => calculateMinimumOut("100", 501), /Slippage/);
  assert.throws(() => calculateMinimumOut("100", 0), /Slippage/);
  assert.throws(() => buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "100", slippageBps: Number.NaN, fee: { enabled: false, feeBps: 0 } }), /Slippage/);
});

test("matches the x*y=k reference numbers for both directions", () => {
  // Independently computed: fee = ceil(in * 30 / 10000), out = floor(rOut * (in - fee) / (rIn + in - fee)).
  assert.deepEqual(constantProductOut("9990000", "1000000000", "2500000000", 30), { amountOut: "24654515", fee: "29970" });
  assert.deepEqual(constantProductOut("24975000", "2500000000", "1000000000", 30), { amountOut: "9861806", fee: "74925" });
  assert.deepEqual(constantProductOut("0", "1000", "1000", 30), { amountOut: "0", fee: "0" });
});

test("quotes a buy (QOR in) with the interface fee taken before the AMM and minOut from the chain quote", () => {
  // 10 QOR in, 10 bps interface fee: 0.01 QOR to the treasury, 9.99 QOR to the AMM.
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "10000000", slippageBps: 50, fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  assert.equal(request.swapAmountIn, "9990000");
  const quote = buildSwapQuote({ request, pool, params, chain: chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB) });
  assert.equal(quote.denomOut, "utest");
  assert.equal(quote.amountOut, "24654515");
  assert.equal(quote.minOut, "24531242");
  assert.equal(quote.nativeAmmFee, "29970");
  assert.deepEqual(quote.interfaceFee, { enabled: true, amount: "10000", denom: "uqor", feeBps: 10 });
  assert.equal(quote.priceImpactBps, 129);
  assert.equal(quote.blocked, null);
  assert.equal(quote.source, "chain");
  assert.equal(quote.reserveIn, "1000000000");
});

test("quotes a sell (token B in) against the reversed reserves", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "utest", amountIn: "25000000", slippageBps: 100, fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  assert.equal(request.swapAmountIn, "24975000");
  const quote = buildSwapQuote({ request, pool, params, chain: chainLike(request.swapAmountIn, pool.reserveB, pool.reserveA) });
  assert.equal(quote.denomOut, "uqor");
  assert.equal(quote.amountOut, "9861806");
  assert.equal(quote.minOut, "9763187");
  assert.equal(quote.reserveIn, "2500000000");
  assert.equal(quote.reserveOut, "1000000000");
});

test("uses the chain's amount even when local math differs", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "10000000", fee: { enabled: false, feeBps: 0 } });
  const quote = buildSwapQuote({ request, pool, params, chain: { ok: true, amountOut: "24000000", fee: "30000" } });
  assert.equal(quote.amountOut, "24000000");
  assert.equal(quote.minOut, "23880000");
});

test("blocks a swap above the chain's 5% impact cap and offers the largest amount that fits", () => {
  // 100 QOR into a 1,000 QOR pool moves the price 9.34% including the fee.
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "100000000", fee: { enabled: false, feeBps: 0 } });
  const quote = buildSwapQuote({ request, pool, params, chain: chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB) });
  assert.equal(quote.priceImpactBps, 934);
  assert.equal(quote.blocked, "impact");
  assert.equal(quote.minOut, "0");
  assert.equal(quote.maxAmountIn, "49572928");

  // The suggested maximum itself passes the cap; a little more does not.
  const max = BigInt(quote.maxAmountIn as string);
  const at = constantProductOut(max, pool.reserveA, pool.reserveB, 30).amountOut;
  assert.ok(priceImpactBps(max, at, pool.reserveA, pool.reserveB) <= 500);
  const over = max + BigInt(50_000);
  assert.ok(priceImpactBps(over, constantProductOut(over, pool.reserveA, pool.reserveB, 30).amountOut, pool.reserveA, pool.reserveB) > 500);
});

test("does not report output rounding on a tiny swap as price impact", () => {
  // Pool 6 on Diana: ~199.9M QWAKK and ~20,010 QOR. 1 QWAKK (10 bps interface fee) pays out 99 uqor
  // where the mid price gives 99.9995, so the rounded output alone looked like a 1.00% impact.
  const deep = { ...pool, tokenA: "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23", tokenB: "uqor", reserveA: "199900549076510", reserveB: "20009970041" };
  const request = buildExactInQuoteRequest({ poolId: "6", denomIn: deep.tokenA, amountIn: "1000000", slippageBps: 50, fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  const quote = buildSwapQuote({ request, pool: deep, params, chain: chainLike(request.swapAmountIn, deep.reserveA, deep.reserveB) });
  assert.equal(quote.amountOut, "99");
  assert.equal(quote.priceImpactBps, 100);
  assert.equal(quote.curveImpactBps, 0);
  assert.ok((quote.curveImpactBps ?? Number.POSITIVE_INFINITY) < IMPACT_WARN_BPS);
  assert.equal(quote.blocked, null);
});

test("still reports the real price move of a large swap", () => {
  // 100 QOR into a 1,000 QOR pool: 99.7 QOR after the fee moves the price 9.07%; with the fee the guard reads 9.34%.
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "100000000", fee: { enabled: false, feeBps: 0 } });
  const quote = buildSwapQuote({ request, pool, params, chain: chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB) });
  assert.equal(quote.curveImpactBps, 907);
  assert.equal(quote.priceImpactBps, 934);
  assert.equal(curveImpactBps("0", "1000"), 0);
  assert.equal(curveImpactBps("5", "0"), 10_000);
});

test("grows the maximum by the interface fee so the swap leg stays within the cap", () => {
  const maxSwap = maxSwapInForImpact(pool.reserveA, pool.reserveB, 500, 30) as bigint;
  const total = maxTotalForSwapIn(maxSwap, 10);
  assert.equal(total.toString(), "49622550");
  assert.equal((total - (total * BigInt(10)) / BigInt(10_000)).toString(), maxSwap.toString());
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: total.toString(), fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  const quote = buildSwapQuote({ request, pool, params, chain: chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB) });
  assert.equal(quote.blocked, null);
});

test("blocks when the chain's own quote refuses on impact, using a local estimate for display", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "40000000", fee: { enabled: false, feeBps: 0 } });
  const quote = buildSwapQuote({ request, pool, params, chain: { ok: false, failure: "impact_too_high" } });
  assert.equal(quote.blocked, "impact");
  assert.equal(quote.source, "estimate");
});

test("falls back to local math only for constant-product pools when the quote service is down", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "10000000", fee: { enabled: true, recipient: treasury, feeBps: 10 } });
  const estimate = buildSwapQuote({ request, pool, params, chain: { ok: false, failure: "unavailable" } });
  assert.equal(estimate.source, "estimate");
  assert.equal(estimate.amountOut, "24654515");
  const stable = { ...pool, poolType: "stable_swap", amplificationCoefficient: 200 };
  assert.throws(() => buildSwapQuote({ request, pool: stable, params, chain: { ok: false, failure: "unavailable" } }), (error: unknown) => error instanceof QuoteError && error.failure === "unavailable");
  // Stable pools get no local impact figure; the chain's cap check guards them.
  const stableQuote = buildSwapQuote({ request, pool: stable, params, chain: { ok: true, amountOut: "9980000", fee: "29970" } });
  assert.equal(stableQuote.priceImpactBps, null);
  assert.equal(stableQuote.maxAmountIn, null);
});

test("blocks paused pools, a switched-off module and dust swaps", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "10000000", fee: { enabled: false, feeBps: 0 } });
  const chain = chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB);
  assert.equal(buildSwapQuote({ request, pool: { ...pool, status: "paused" }, params, chain }).blocked, "paused");
  assert.equal(buildSwapQuote({ request, pool, params: { ...params, enabled: false }, chain }).blocked, "disabled");
  const dust = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "1", fee: { enabled: false, feeBps: 0 } });
  const dustQuote = buildSwapQuote({ request: dust, pool, params, chain: { ok: true, amountOut: "1", fee: "1" } });
  assert.equal(dustQuote.blocked, "too_small");
  assert.equal(dustQuote.minOut, "0");
});

test("refuses a token the pool does not trade and maps keeper quote errors", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uother", amountIn: "1000", fee: { enabled: false, feeBps: 0 } });
  assert.throws(() => buildSwapQuote({ request, pool, params, chain: { ok: true, amountOut: "1", fee: "0" } }), (error: unknown) => error instanceof QuoteError && error.failure === "pair");
  assert.throws(() => buildSwapQuote({ request: { ...request, denomIn: "uqor" }, pool, params, chain: { ok: false, failure: "pool_not_found" } }), QuoteError);
  // Diana answers a missing pool with gRPC code 3 "pool not found".
  assert.equal(classifyQuoteError("pool not found"), "pool_not_found");
  assert.equal(classifyQuoteError("swap exceeds max price impact"), "impact_too_high");
  assert.equal(classifyQuoteError("insufficient liquidity"), "insufficient_liquidity");
  assert.equal(classifyQuoteError("strconv.ParseUint: parsing"), "invalid");
});

test("parses typed price protection and refuses nonsense", () => {
  assert.equal(parseSlippagePercent("0.5"), 50);
  assert.equal(parseSlippagePercent("0.5%"), 50);
  assert.equal(parseSlippagePercent(".25"), 25);
  assert.equal(parseSlippagePercent("1"), 100);
  assert.equal(parseSlippagePercent("5"), 500);
  assert.equal(parseSlippagePercent("0.01"), 1);
  for (const bad of ["", "0", "0.001", "5.01", "50", "-1", "abc", "1e2", "1.2.3"]) assert.equal(parseSlippagePercent(bad), null, bad);
});

test("signs a fresh quote only when it still guarantees the reviewed minimum", () => {
  assert.equal(requoteDecision("24531242", { minOut: "24531242", blocked: null }), "sign");
  assert.equal(requoteDecision("24531242", { minOut: "24600000", blocked: null }), "sign");
  assert.equal(requoteDecision("24531242", { minOut: "24531241", blocked: null }), "review");
  assert.equal(requoteDecision("24531242", { minOut: "0", blocked: "impact" }), "review");
});

test("keys a quote to its exact inputs", () => {
  const base = { poolId: "1", denomIn: "uqor", amountIn: "10000000", slippageBps: 50 };
  assert.notEqual(quoteKey(base), quoteKey({ ...base, denomIn: "utest" }));
  assert.notEqual(quoteKey(base), quoteKey({ ...base, slippageBps: 100 }));
  assert.notEqual(quoteKey(base), quoteKey({ ...base, amountIn: "10000001" }));
  assert.equal(quoteKey(base), quoteKey({ ...base }));
});

test("keeps QOR aside for the network fee when checking a balance", () => {
  const balances = new Map([["uqor", BigInt(10_000_000)], ["utest", BigInt(5_000_000)]]);
  assert.equal(coversSpend({ balances, spend: [{ denom: "uqor", amount: (BigInt(10_000_000) - NETWORK_FEE_RESERVE_UQOR).toString() }] }), true);
  assert.equal(coversSpend({ balances, spend: [{ denom: "uqor", amount: "9950000" }] }), false);
  assert.equal(coversSpend({ balances, spend: [{ denom: "utest", amount: "5000000" }] }), true);
  assert.equal(coversSpend({ balances: new Map([["utest", BigInt(5_000_000)]]), spend: [{ denom: "utest", amount: "1" }] }), false);
  // A new pool needs the 100 QOR creation fee on top of the deposits.
  const rich = new Map([["uqor", BigInt(150_000_000)], ["utest", BigInt(1_000_000)]]);
  assert.equal(coversSpend({ balances: rich, spend: [{ denom: "uqor", amount: "49000000" }, { denom: "utest", amount: "1000000" }], extraUqor: BigInt(100_000_000) }), true);
  assert.equal(coversSpend({ balances: rich, spend: [{ denom: "uqor", amount: "50000000" }, { denom: "utest", amount: "1000000" }], extraUqor: BigInt(100_000_000) }), false);
});

test("never falls back to the local estimate when a chain quote is required (mainnet)", () => {
  const request = buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: "10000000", fee: { enabled: false, feeBps: 0 } });
  for (const failure of ["unavailable", "impact_too_high"] as const) {
    assert.throws(
      () => buildSwapQuote({ request, pool, params, chain: { ok: false, failure }, allowEstimate: false }),
      (error: unknown) => error instanceof QuoteError && error.failure === failure,
    );
  }
  const chain = chainLike(request.swapAmountIn, pool.reserveA, pool.reserveB);
  assert.equal(buildSwapQuote({ request, pool, params, chain, allowEstimate: false }).source, "chain");
});
