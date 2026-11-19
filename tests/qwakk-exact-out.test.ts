import assert from "node:assert/strict";
import test from "node:test";

import { qorechainRegistry } from "@qorechain/sdk";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";

import type { AmmParams, AmmPool, ChainExactOutQuote } from "../lib/qwakk-amm-chain";
import { parseAmmParams, parseAmmPool } from "../lib/qwakk-amm-chain";
import { constantProductIn, constantProductOut, interfaceFeeFor, priceImpactBps, totalForSwapIn } from "../lib/qwakk-amm-math";
import { encodedMessagesForAction, exactOutQuoteCheck, interfaceFeeInMessages, isExactOutSwap, messagesForAction, parseNativeAction, type ExactOutSwapAction } from "../lib/qwakk-native-actions";
import { isAllowedMessageSet, requiredSpend } from "../lib/qwakk-native-tx";
import {
  QuoteError,
  buildExactInQuoteRequest,
  buildExactOutQuoteRequest,
  buildExactOutSwapQuote,
  calculateMaximumIn,
  quoteKey,
  requoteExactOutDecision,
} from "../lib/qwakk-quote";
import { MAX_EXACT_OUT_PADDING_BPS, buildQwakkExactOutSwapRoute } from "../lib/qwakk-swap-route";

const sender = "qor1exampleaddress000000000000";
const treasury = "qor1treasuryaddress0000000000000";
const withFee = { enabled: true as const, recipient: treasury, feeBps: 10 };
const noFee = { enabled: false as const, feeBps: 10 };

const params = parseAmmParams({ params: { swap_fee_bps: 30, protocol_fee_bps: 10, min_liquidity: "1000", max_pools_per_creator: 50, lp_token_decimals: 6, pool_creation_fee: "100000000", max_swap_impact_bps: 500, enabled: true } }) as AmmParams;
/** 1,000 QOR against 2,500 TEST, sorted uqor < utest. */
const pool = parseAmmPool({ id: "1", pool_type: "constant_product", creator: "qor1creator", token_a: "uqor", token_b: "utest", reserve_a: "1000000000", reserve_b: "2500000000", lp_supply: "1581138830", created_at: "8000000", status: "active", amplification_coefficient: 0 }) as AmmPool;

function chainLike(amountOut: string, reserveIn: string, reserveOut: string): ChainExactOutQuote {
  const quote = constantProductIn(amountOut, reserveIn, reserveOut, 30);
  return quote ? { ok: true, ...quote } : { ok: false, failure: "insufficient_liquidity" };
}

test("reproduces QoreChain Diana's QuoteExactOut to the unit", () => {
  // Live pool 2 (fUSD/QOR) on 2026-11-19: reserves 449455507 fUSD / 10104499704 uqor.
  assert.deepEqual(constantProductIn("10000000", "10104499704", "449455507", 30), { amountIn: "230624132", fee: "691873" });
  assert.deepEqual(constantProductIn("10000000", "449455507", "10104499704", 30), { amountIn: "446588", fee: "1340" });
  // The verifier run on pool 2: chain in 1129845 fee 3390 for 25261249 uqor out.
  assert.deepEqual(constantProductIn("1123638", "10104499704", "449455507", 30), { amountIn: "25400747", fee: "76203" });
});

test("an exact-out input always buys at least the requested output", () => {
  for (const out of ["1", "7", "1000", "10000000", "123456789"]) {
    const quote = constantProductIn(out, "1000000000", "2500000000", 30);
    assert.ok(quote);
    assert.ok(BigInt(constantProductOut(quote.amountIn, "1000000000", "2500000000", 30).amountOut) >= BigInt(out));
    // One unit less never reaches it, so the input is the smallest that works.
    assert.ok(BigInt(constantProductOut(BigInt(quote.amountIn) - BigInt(1), "1000000000", "2500000000", 30).amountOut) < BigInt(out));
  }
});

test("refuses an output the pool cannot pay", () => {
  assert.equal(constantProductIn("2500000000", "1000000000", "2500000000", 30), null);
  assert.equal(constantProductIn("2600000000", "1000000000", "2500000000", 30), null);
  assert.equal(constantProductIn("0", "1000000000", "2500000000", 30), null);
  assert.equal(constantProductIn("1", "0", "2500000000", 30), null);
});

test("finds the total whose swap leg after the interface fee is exactly the quoted input", () => {
  for (const swapIn of [BigInt(1), BigInt(999), BigInt(1000), BigInt(9_990), BigInt(4_028_150), BigInt(230_624_132), BigInt("123456789012345678")]) {
    for (const feeBps of [0, 5, 10, 30]) {
      const total = totalForSwapIn(swapIn, feeBps);
      assert.equal(total - interfaceFeeFor(total, feeBps), swapIn, `${swapIn} at ${feeBps} bps`);
      assert.ok(total - BigInt(1) - interfaceFeeFor(total - BigInt(1), feeBps) < swapIn, "smallest such total");
    }
  }
  assert.equal(totalForSwapIn("0", 10), BigInt(0));
});

test("validates an exact-out quote request", () => {
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "0010000000", fee: withFee });
  assert.equal(request.amountOut, "10000000");
  assert.equal(request.slippageBps, 50);
  assert.throws(() => buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "0", fee: withFee }), /Receive amount/);
  assert.throws(() => buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "1.5", fee: withFee }), /Receive amount/);
  assert.throws(() => buildExactOutQuoteRequest({ poolId: "0", denomIn: "uqor", amountOut: "1", fee: withFee }), /pool ID/);
  assert.throws(() => buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "1", slippageBps: 501, fee: withFee }), /Slippage/);
});

test("pads only the AMM leg for price protection, rounded up", () => {
  assert.equal(calculateMaximumIn("4028150", 50), "4048291");
  assert.equal(calculateMaximumIn("1", 1), "2");
  assert.equal(calculateMaximumIn("10000", 100), "10100");
  assert.throws(() => calculateMaximumIn("0", 50), /positive/);
  assert.throws(() => calculateMaximumIn("100", 0), /Slippage/);
});

test("quotes a fixed receive amount with the interface fee on the quoted input, not on the padding", () => {
  // Receive exactly 10 TEST, pay QOR.
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "10000000", slippageBps: 50, fee: withFee });
  const quote = buildExactOutSwapQuote({ request, pool, params, chain: chainLike("10000000", pool.reserveA, pool.reserveB) });
  assert.equal(quote.mode, "exact_out");
  assert.equal(quote.denomOut, "utest");
  assert.equal(quote.amountOut, "10000000");
  assert.equal(quote.minOut, "10000000");
  assert.equal(quote.swapAmountIn, "4028150");
  assert.equal(quote.nativeAmmFee, "12085");
  // 10 bps of the 4032182 total, rounded down: the same fee an exact-in swap of that total pays.
  assert.equal(quote.totalAmountIn, "4032182");
  assert.deepEqual(quote.interfaceFee, { enabled: true, amount: "4032", denom: "uqor", feeBps: 10 });
  assert.equal(buildExactInQuoteRequest({ poolId: "1", denomIn: "uqor", amountIn: quote.totalAmountIn, fee: withFee }).swapAmountIn, quote.swapAmountIn);
  assert.equal(quote.maxIn, "4048291");
  assert.equal(quote.maxTotalIn, "4052323");
  assert.equal(BigInt(quote.maxTotalIn), BigInt(quote.interfaceFee.amount) + BigInt(quote.maxIn));
  assert.equal(quote.priceImpactBps, 70);
  assert.equal(quote.blocked, null);
  assert.equal(quote.source, "chain");
});

test("quotes the reverse direction against the reversed reserves", () => {
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "utest", amountOut: "4000000", slippageBps: 100, fee: noFee });
  const quote = buildExactOutSwapQuote({ request, pool, params, chain: chainLike("4000000", pool.reserveB, pool.reserveA) });
  assert.equal(quote.denomOut, "uqor");
  assert.equal(quote.swapAmountIn, "10070373");
  assert.equal(quote.totalAmountIn, "10070373");
  assert.equal(quote.interfaceFee.amount, "0");
  assert.equal(quote.maxIn, calculateMaximumIn("10070373", 100));
  assert.equal(quote.maxTotalIn, quote.maxIn);
  assert.equal(quote.reserveIn, "2500000000");
});

test("blocks an exact-out swap over the impact cap and offers the largest output that fits", () => {
  // 600 TEST out of 2,500 moves the price far past 5%.
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "600000000", fee: withFee });
  const quote = buildExactOutSwapQuote({ request, pool, params, chain: { ok: false, failure: "impact_too_high" } });
  assert.equal(quote.blocked, "impact");
  assert.equal(quote.source, "estimate");
  assert.equal(quote.minOut, "0");
  assert.equal(quote.maxIn, "0");
  assert.equal(quote.maxTotalIn, "0");
  assert.ok(quote.maxAmountOut);
  // The suggested output itself fits within the cap.
  const fit = constantProductIn(quote.maxAmountOut, pool.reserveA, pool.reserveB, 30);
  assert.ok(fit);
  assert.ok(priceImpactBps(fit.amountIn, quote.maxAmountOut, pool.reserveA, pool.reserveB) <= params.maxSwapImpactBps);
});

test("explains an output above the pool's reserve and a pool type without exact-out quotes", () => {
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "2500000000", fee: withFee });
  assert.throws(
    () => buildExactOutSwapQuote({ request, pool, params, chain: { ok: false, failure: "insufficient_liquidity" } }),
    (error: unknown) => error instanceof QuoteError && error.failure === "insufficient_liquidity",
  );
  // The quote service is down and the estimate cannot pay out either.
  assert.throws(
    () => buildExactOutSwapQuote({ request, pool, params, chain: { ok: false, failure: "unavailable" } }),
    (error: unknown) => error instanceof QuoteError && error.failure === "insufficient_liquidity",
  );
  const stable = { ...pool, poolType: "stable_swap" };
  assert.throws(
    () => buildExactOutSwapQuote({ request: { ...request, amountOut: "1000" }, pool: stable, params, chain: { ok: true, amountIn: "1000", fee: "3" } }),
    (error: unknown) => error instanceof QuoteError && error.failure === "exact_out_unsupported",
  );
  assert.throws(
    () => buildExactOutSwapQuote({ request: { ...request, denomIn: "uatom" }, pool, params, chain: { ok: true, amountIn: "1000", fee: "3" } }),
    (error: unknown) => error instanceof QuoteError && error.failure === "pair",
  );
});

test("never signs an exact-out estimate when a chain quote is required (mainnet)", () => {
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "10000000", fee: withFee });
  for (const failure of ["unavailable", "impact_too_high"] as const) {
    assert.throws(
      () => buildExactOutSwapQuote({ request, pool, params, chain: { ok: false, failure }, allowEstimate: false }),
      (error: unknown) => error instanceof QuoteError && error.failure === failure,
    );
  }
  const estimate = buildExactOutSwapQuote({ request, pool, params, chain: { ok: false, failure: "unavailable" } });
  assert.equal(estimate.source, "estimate");
  assert.equal(estimate.swapAmountIn, "4028150");
});

test("blocks paused pools and a switched-off module", () => {
  const request = buildExactOutQuoteRequest({ poolId: "1", denomIn: "uqor", amountOut: "10000000", fee: withFee });
  const chain = chainLike("10000000", pool.reserveA, pool.reserveB);
  assert.equal(buildExactOutSwapQuote({ request, pool: { ...pool, status: "paused" }, params, chain }).blocked, "paused");
  assert.equal(buildExactOutSwapQuote({ request, pool, params: { ...params, enabled: false }, chain }).blocked, "disabled");
});

test("signs a fresh exact-out quote only for the same output at no more than the reviewed maximum", () => {
  const reviewed = { amountOut: "10000000", maxTotalIn: "4052323" };
  const fresh = (maxTotalIn: string, extra: Partial<{ amountOut: string; blocked: "impact" | null; mode: "exact_in" | "exact_out" }> = {}) => ({ mode: "exact_out" as const, amountOut: "10000000", maxTotalIn, blocked: null, ...extra });
  assert.equal(requoteExactOutDecision(reviewed, fresh("4052323")), "sign");
  assert.equal(requoteExactOutDecision(reviewed, fresh("4050000")), "sign");
  assert.equal(requoteExactOutDecision(reviewed, fresh("4052324")), "review");
  assert.equal(requoteExactOutDecision(reviewed, fresh("4000000", { amountOut: "9999999" })), "review");
  assert.equal(requoteExactOutDecision(reviewed, fresh("0", { blocked: "impact" })), "review");
  assert.equal(requoteExactOutDecision(reviewed, fresh("4000000", { mode: "exact_in" })), "review");
});

test("keys an exact-out quote apart from an exact-in quote of the same number", () => {
  const base = { poolId: "1", denomIn: "uqor", slippageBps: 50 };
  assert.notEqual(quoteKey({ ...base, amountIn: "10000000" }), quoteKey({ ...base, amountOut: "10000000" }));
  assert.notEqual(quoteKey({ ...base, amountOut: "10000000" }), quoteKey({ ...base, amountOut: "10000001" }));
  assert.equal(quoteKey({ ...base, amountIn: "10000000" }), "1|uqor|10000000|50");
});

const registry = qorechainRegistry();

test("builds the interface fee transfer and MsgSwapExactOut in one transaction", () => {
  const route = buildQwakkExactOutSwapRoute({ sender, poolId: "1", denomIn: "uqor", amountIn: "4032182", denomOut: "utest", amountOut: "10000000", maxIn: "4048291", fee: { recipient: treasury, feeBps: 10 } });
  assert.equal(route.swapAmount, "4028150");
  assert.deepEqual(route.interfaceFee, { denom: "uqor", amount: "4032" });
  assert.deepEqual(route.messages.map((message) => message.typeUrl), ["/cosmos.bank.v1beta1.MsgSend", "/qorechain.amm.v1.MsgSwapExactOut"]);
  const send = route.messages[0].value as { fromAddress: string; toAddress: string; amount: Array<{ denom: string; amount: string }> };
  assert.equal(send.fromAddress, sender);
  assert.equal(send.toAddress, treasury);
  assert.deepEqual(send.amount, [{ denom: "uqor", amount: "4032" }]);
  // Field names from @qorechain/sdk 0.8.2 MsgSwapExactOut.
  assert.deepEqual(route.messages[1].value, { sender, poolId: "1", denomIn: "uqor", tokenOut: { denom: "utest", amount: "10000000" }, maxIn: "4048291" });
});

test("refuses an exact-out route whose maximum does not match the quoted input", () => {
  const base = { sender, poolId: "1", denomIn: "uqor", amountIn: "4032182", denomOut: "utest", amountOut: "10000000", maxIn: "4048291", fee: { recipient: treasury, feeBps: 10 } };
  // Below the quoted swap leg: it could never fill.
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, maxIn: "4028149" }), /maximum input/);
  // Far above the quote: that would let a tiny total (and fee) carry a large swap.
  const ceiling = (BigInt(4_028_150) * BigInt(10_000 + MAX_EXACT_OUT_PADDING_BPS) + BigInt(9_999)) / BigInt(10_000);
  assert.doesNotThrow(() => buildQwakkExactOutSwapRoute({ ...base, maxIn: ceiling.toString() }));
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, maxIn: (ceiling + BigInt(1)).toString() }), /maximum input/);
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, maxIn: "0" }), /maximum input is required/);
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, amountOut: "0" }), /Receive amount/);
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, denomOut: "uqor" }), /two different/);
  assert.throws(() => buildQwakkExactOutSwapRoute({ ...base, fee: { recipient: treasury, feeBps: 31 } }), /Interface fee/);
});

test("parses and builds an exact-out swap action, with and without a treasury", () => {
  const action = parseNativeAction({ kind: "swap", mode: "exact_out", poolId: "1", denomIn: "uqor", amountIn: "4032182", denomOut: "utest", amountOut: "10000000", maxIn: "4048291", minOut: "1" });
  assert.equal(isExactOutSwap(action), true);
  assert.deepEqual(action, { kind: "swap", mode: "exact_out", poolId: "1", denomIn: "uqor", amountIn: "4032182", denomOut: "utest", amountOut: "10000000", maxIn: "4048291" });
  assert.equal(isExactOutSwap(parseNativeAction({ kind: "swap", poolId: "1", denomIn: "uqor", amountIn: "1", denomOut: "utest", minOut: "1" })), false);

  assert.deepEqual(messagesForAction(sender, action, withFee).map((message) => message.typeUrl), ["/cosmos.bank.v1beta1.MsgSend", "/qorechain.amm.v1.MsgSwapExactOut"]);
  const bare = messagesForAction(sender, action, noFee);
  assert.deepEqual(bare.map((message) => message.typeUrl), ["/qorechain.amm.v1.MsgSwapExactOut"]);
  // Without a treasury the whole quoted total is the swap leg, so maxIn stays within its padding.
  assert.equal((bare[0].value as { maxIn: string }).maxIn, "4048291");
});

test("the guarded encoder allows the exact-out set, discloses its fee and spends fee plus maxIn", () => {
  const action = parseNativeAction({ kind: "swap", mode: "exact_out", poolId: "1", denomIn: "uqor", amountIn: "4032182", denomOut: "utest", amountOut: "10000000", maxIn: "4048291" });
  const encoded = encodedMessagesForAction(sender, action, withFee);
  assert.equal(isAllowedMessageSet(encoded, sender, treasury), true);
  assert.deepEqual(interfaceFeeInMessages(encoded), { denom: "uqor", amount: "4032" });
  assert.equal(MsgSend.decode(encoded[0].value).toAddress, treasury);
  const decoded = registry.decode(encoded[1]) as { denomIn: string; maxIn: string; tokenOut: { denom: string; amount: string } };
  assert.equal(decoded.denomIn, "uqor");
  assert.equal(decoded.maxIn, "4048291");
  assert.deepEqual({ denom: decoded.tokenOut.denom, amount: decoded.tokenOut.amount }, { denom: "utest", amount: "10000000" });
  // The balance check covers the fee transfer plus the most the AMM leg may take.
  assert.deepEqual([...requiredSpend(encoded)], [["uqor", BigInt(4_052_323)]]);
});

test("refuses an exact-out total that understates the chain's input, so the interface fee cannot be shrunk", () => {
  // Live pool 2: 10 fUSD out needs A = 230624132 uqor at the AMM (QuoteExactOut, 2026-11-19).
  const chainAmountIn = "230624132";
  const fee = { enabled: true as const, recipient: treasury, feeBps: 10 };
  const honestTotal = totalForSwapIn(chainAmountIn, 10);
  assert.equal(honestTotal - BigInt(chainAmountIn), BigInt(230_854));
  const action = (amountIn: string, maxIn: string): ExactOutSwapAction => ({ kind: "swap", mode: "exact_out", poolId: "2", denomIn: "uqor", amountIn, denomOut: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", amountOut: "10000000", maxIn });

  // The honest quote, and one whose price moved in the trader's favour, pass.
  assert.equal(exactOutQuoteCheck(action(honestTotal.toString(), calculateMaximumIn(chainAmountIn, 50)), fee, chainAmountIn), "ok");
  assert.equal(exactOutQuoteCheck(action(honestTotal.toString(), calculateMaximumIn(chainAmountIn, 50)), fee, "230000000"), "ok");

  // Crafted: swap leg S' = ceil(A / 1.05) with maxIn = A. The builder alone accepts it,
  // with a fee of 219861 instead of 230854, and the AMM would take A within maxIn.
  const craftedLeg = (BigInt(chainAmountIn) * BigInt(10_000) + BigInt(10_499)) / BigInt(10_500);
  const craftedTotal = totalForSwapIn(craftedLeg, 10);
  const crafted = action(craftedTotal.toString(), chainAmountIn);
  assert.equal(buildQwakkExactOutSwapRoute({ sender, ...crafted, fee: { recipient: treasury, feeBps: 10 } }).interfaceFee.amount, "219861");
  assert.equal(exactOutQuoteCheck(crafted, fee, chainAmountIn), "price_moved");

  // One unit short of the chain's input is refused too; an adverse move asks for a new review.
  assert.equal(exactOutQuoteCheck(action((honestTotal - BigInt(1)).toString(), chainAmountIn), fee, chainAmountIn), "price_moved");
  assert.equal(exactOutQuoteCheck(action(honestTotal.toString(), calculateMaximumIn(chainAmountIn, 50)), fee, "230624133"), "price_moved");
  // Without a treasury the whole total is the swap leg.
  assert.equal(exactOutQuoteCheck(action(chainAmountIn, chainAmountIn), noFee, chainAmountIn), "ok");
  assert.equal(exactOutQuoteCheck(action((BigInt(chainAmountIn) - BigInt(1)).toString(), chainAmountIn), noFee, chainAmountIn), "price_moved");
});
