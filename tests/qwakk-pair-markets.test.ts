import assert from "node:assert/strict";
import test from "node:test";

import { eventValues, parseSwapEvent } from "../indexer/amm-events";
import { catchUpRange, catchUpWithSearch, CATCH_UP_MARGIN, CATCH_UP_SPAN, resumeAfterPruning, verifyEventSearch } from "../indexer/block-sync";
import {
  applyTradeToCandles, candleInQuote, chooseQuoteSide, dustThreshold, invertPrice, knownDecimals, liquidityStatus, marketSummary, pairFigures,
  poolTvlInQuote, priceInQuote, spotPriceInQuote, swapTrade, type Candle,
} from "../indexer/market-math";
import { fallbackSymbol, quoteRank, resolveTokenInfo } from "../indexer/token-registry";

// QoreChain Diana denoms, as the chain returns them (mixed case erc20 addresses).
const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
const FBTC = "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";

test("curated tokens win over chain metadata, including the ATOM micro unit", () => {
  // Diana metadata for the IBC ATOM denom: only uatom at exponent 0, symbol UATOM.
  const atomMetadata = { symbol: "UATOM", name: "transfer/channel-0/uatom IBC token", display: "transfer/channel-0/uatom", base: ATOM, denom_units: [{ denom: "uatom", exponent: 0 }] };
  assert.deepEqual(resolveTokenInfo(ATOM, atomMetadata), { symbol: "ATOM", name: "Cosmos Hub ATOM", decimals: 6, imageUrl: null, source: "curated" });
  assert.equal(resolveTokenInfo(ATOM.toLowerCase(), undefined).decimals, 6);
  assert.equal(resolveTokenInfo(FETH, undefined).decimals, 18);
  assert.equal(resolveTokenInfo(FBTC, undefined).decimals, 8);
  assert.equal(resolveTokenInfo(FUSD, undefined).symbol, "fUSD");
  assert.equal(resolveTokenInfo("uqor", undefined).decimals, 6);
});

test("reads chain metadata for unlisted tokens and leaves exponent 0 only metadata unknown", () => {
  const erc20 = "erc20:0x1111111111111111111111111111111111111111";
  const erc20Metadata = { symbol: "fDOGE", name: erc20, display: "FestDOGE", base: erc20, denom_units: [{ denom: erc20, exponent: 0 }, { denom: "FestDOGE", exponent: 18 }] };
  assert.deepEqual(resolveTokenInfo(erc20, erc20Metadata), { symbol: "fDOGE", name: "FestDOGE", decimals: 18, imageUrl: null, source: "chain" });

  // An uncurated IBC token whose metadata lists only uosmo at exponent 0: no guessed 6.
  const ibc = "ibc/ABCDEF0000000000000000000000000000000000000000000000000000001234";
  const osmo = resolveTokenInfo(ibc, { symbol: "UOSMO", display: "transfer/channel-1/uosmo", base: ibc, denom_units: [{ denom: "uosmo", exponent: 0 }] });
  assert.equal(osmo.decimals, null);
  assert.equal(osmo.source, "chain");
  assert.deepEqual(resolveTokenInfo(ibc, undefined), { symbol: "IBC ABCD\u20261234", name: null, decimals: null, imageUrl: null, source: "fallback" });
});

test("fallback labels match the app's displaySymbol format", () => {
  assert.equal(fallbackSymbol("erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CB"), "0x9714\u202663CB");
  assert.equal(fallbackSymbol("ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB3"), "IBC 2739\u20265EB3");
  assert.equal(fallbackSymbol("ufoo"), "FOO");
  assert.equal(fallbackSymbol("factory/qor1abcdefghij/longsubdenomname"), "longsubd\u2026name");
  assert.equal(fallbackSymbol(FUSD), "fUSD");
});

test("pools with a token of unknown decimals stay unpriced", () => {
  const base = { poolType: "constant_product", reserveA: "5000000", reserveB: "100000000", priceBPerA: "20", price24hAgoBPerA: "19", volumeQuote24h: "12", quoteSide: "b" as const, minTvl: null };
  const unknown = pairFigures({ ...base, decimalsA: 6, decimalsB: null });
  assert.equal(unknown.decimalsKnown, false);
  assert.equal(unknown.priceQuote, null);
  assert.equal(unknown.spotPriceQuote, null);
  assert.equal(unknown.spotPriceBPerA, null);
  assert.equal(unknown.volumeQuote24h, null);
  assert.equal(unknown.tvlQuote, null);
  assert.deepEqual(unknown.liquidity, { lowLiquidity: true, reason: "unknown_decimals" });

  const known = pairFigures({ ...base, decimalsA: 6, decimalsB: 6 });
  assert.equal(known.decimalsKnown, true);
  assert.equal(known.priceQuote, "20");
  assert.equal(known.priceChangePercent24h, "5.2631");
  assert.equal(known.spotPriceQuote, "20");
  assert.equal(known.tvlQuote, "200");
  assert.equal(known.volumeQuote24h, "12");

  assert.equal(knownDecimals(null), null);
  assert.equal(knownDecimals("18"), 18);
  assert.equal(knownDecimals(0), 0);
  assert.equal(knownDecimals(-1), null);
});

test("quotes in QOR first, then fUSD, otherwise token B", () => {
  assert.equal(chooseQuoteSide(quoteRank(FETH), quoteRank("uqor")), "b");
  assert.equal(chooseQuoteSide(quoteRank("uqor"), quoteRank(FETH)), "a");
  assert.equal(chooseQuoteSide(quoteRank(FUSD), quoteRank("uqor")), "b");
  assert.equal(chooseQuoteSide(quoteRank(FUSD), quoteRank(ATOM)), "a");
  assert.equal(chooseQuoteSide(quoteRank(FETH), quoteRank(FUSD)), "b");
  assert.equal(chooseQuoteSide(quoteRank(FETH), quoteRank(ATOM)), "b");
  assert.equal(quoteRank(FUSD.toLowerCase()), 1);
});

test("prices the first Diana swap on pool 1 (fETH/QOR, 18 and 6 decimals) exactly", () => {
  // Block 9003794: 10000 uqor in, 9871 wei fETH out.
  const swap = parseSwapEvent(eventValues({
    type: "amm_swap",
    attributes: [
      { key: "pool_id", value: "1" }, { key: "sender", value: "qor1a97tldp0xjef47kz36u6kgkex7sqdmxzxgc36y" },
      { key: "denom_in", value: "uqor" }, { key: "denom_out", value: FETH },
      { key: "amount_in", value: "10000" }, { key: "amount_out", value: "9871" },
    ],
  }));
  assert.ok(swap);
  const trade = swapTrade(swap, { tokenA: FETH, tokenB: "uqor", decimalsA: 18, decimalsB: 6, quoteSide: "b" });
  assert.equal(trade.price, "1013068584743.187113767602066659");
  assert.equal(trade.volumeQor, "0.01");
  assert.equal(trade.volumeQuote, "0.01");
});

test("handles a pair without QOR: fETH/fUSD volume is in fUSD, with no float rounding", () => {
  const pool = { tokenA: FETH, tokenB: FUSD, decimalsA: 18, decimalsB: 6, quoteSide: "b" as const };
  // 1.5 fETH (1500000000000000000 wei) for 4500.123456 fUSD.
  const sell = swapTrade({ denomIn: FETH, amountIn: "1500000000000000000", denomOut: FUSD, amountOut: "4500123456" }, pool);
  assert.equal(sell.price, "3000.082304");
  assert.equal(sell.volumeQor, null);
  assert.equal(sell.volumeQuote, "4500.123456");
  // 3000 fUSD in for 0.999999999999999999 fETH: an 18 decimal amount past float precision.
  const buy = swapTrade({ denomIn: FUSD, amountIn: "3000000000", denomOut: FETH, amountOut: "999999999999999999" }, pool);
  assert.equal(buy.price, "3000.000000000000003");
  assert.equal(buy.volumeQuote, "3000");

  const candles = new Map<string, Candle>();
  applyTradeToCandles(candles, new Date("2026-10-31T10:00:10Z"), sell.price as string, sell.volumeQor, sell.volumeQuote);
  applyTradeToCandles(candles, new Date("2026-10-31T10:00:40Z"), buy.price as string, buy.volumeQor, buy.volumeQuote);
  const minute = candles.get("1m|2026-10-31T10:00:00.000Z");
  assert.equal(minute?.volumeQor, null);
  assert.equal(minute?.volumeQuote, "7500.123456");
  assert.equal(minute?.high, "3000.082304");
  const summary = marketSummary([...candles.values()], new Date("2026-10-31T12:00:00Z"));
  assert.equal(summary.volumeQor24h, null);
  assert.equal(summary.volumeQuote24h, "7500.123456");
});

test("turns B-per-A prices and candles into quote per base when token A is the quote", () => {
  assert.equal(invertPrice("4"), "0.25");
  assert.equal(invertPrice("3"), "0.333333333333333333");
  assert.equal(invertPrice("0"), null);
  assert.equal(priceInQuote("0.25", "a"), "4");
  assert.equal(priceInQuote("2.50", "b"), "2.5");
  assert.equal(priceInQuote(null, "a"), null);
  // QOR/fETH with QOR as token A: candles store fETH per QOR.
  const candle = { start_time: "x", open: "0.5", high: "0.8", low: "0.4", close: "0.625" };
  assert.deepEqual(candleInQuote(candle, "a"), { start_time: "x", open: "2", high: "2.5", low: "1.25", close: "1.6" });
  assert.equal(candleInQuote(candle, "b"), candle);
});

test("flags pool 1's dust reserves as low liquidity and values pools in the quote token", () => {
  const pool1 = { poolType: "constant_product", reserveA: "980129", reserveB: "1020319", decimalsA: 18, decimalsB: 6, quoteSide: "b" as const };
  assert.equal(spotPriceInQuote(pool1), "1041004806510.163458075416603324");
  assert.equal(poolTvlInQuote(pool1, null), "2.040638");
  assert.deepEqual(liquidityStatus(pool1, "2.040638", "10"), { lowLiquidity: true, reason: "dust_reserve" });

  // 2 fETH against 6000 fUSD.
  const healthy = { poolType: "constant_product", reserveA: "2000000000000000000", reserveB: "6000000000", decimalsA: 18, decimalsB: 6, quoteSide: "b" as const };
  assert.equal(spotPriceInQuote(healthy), "3000");
  assert.equal(poolTvlInQuote(healthy, null), "12000");
  assert.deepEqual(liquidityStatus(healthy, "12000", "10"), { lowLiquidity: false, reason: null });

  // Quote on side A: 5 QOR against 1 fBTC is under the 10 QOR minimum.
  const thin = { poolType: "constant_product", reserveA: "5000000", reserveB: "100000000", decimalsA: 6, decimalsB: 8, quoteSide: "a" as const };
  assert.equal(spotPriceInQuote(thin), "5");
  assert.equal(poolTvlInQuote(thin, null), "10");
  assert.deepEqual(liquidityStatus({ ...thin, reserveA: "4000000" }, "8", "10"), { lowLiquidity: true, reason: "below_min_tvl" });

  // Stableswap needs a traded price for the base side.
  const stable = { ...healthy, poolType: "stableswap", reserveB: "2000000" };
  assert.equal(poolTvlInQuote(stable, null), null);
  assert.equal(poolTvlInQuote(stable, "1.5"), "5");

  assert.deepEqual(liquidityStatus({ ...healthy, reserveB: "0" }, null, null), { lowLiquidity: true, reason: "empty" });
  assert.equal(dustThreshold(18), BigInt("1000000000000"));
  assert.equal(dustThreshold(6), BigInt(1000));
});

test("resumes at the node's earliest kept block when the saved height was pruned", () => {
  // The local database stopped at 7621941; Diana keeps blocks from 8790799.
  assert.deepEqual(resumeAfterPruning(7621941, 8790799), { savedHeight: 8790798, skipped: { from: 7621942, to: 8790798 } });
  assert.deepEqual(resumeAfterPruning(9000000, 8790799), { savedHeight: 9000000, skipped: null });
  assert.deepEqual(resumeAfterPruning(8790798, 8790799), { savedHeight: 8790798, skipped: null });
  assert.deepEqual(resumeAfterPruning(100, 0), { savedHeight: 100, skipped: null });
});

test("catches up through an event search and scans only near the tip", async () => {
  assert.equal(catchUpRange(1000, 1200), null);
  assert.deepEqual(catchUpRange(1000, 2000), { from: 1001, to: 2000 - CATCH_UP_MARGIN });
  assert.deepEqual(catchUpRange(1000, 1000 + CATCH_UP_SPAN * 3), { from: 1001, to: 1000 + CATCH_UP_SPAN });

  const processed: number[] = [];
  const saved: number[] = [];
  const found = await catchUpWithSearch(8790799, 8810798, {
    findHeights: async () => [9003866, 8800000, 8800000, 1, 99999999],
    processBlock: async (height) => { processed.push(height); },
    saveHeight: async (height) => { saved.push(height); },
  });
  assert.equal(found, 1);
  assert.deepEqual(processed, [8800000]);
  assert.deepEqual(saved, [8800000, 8810798]);

  // A failing block stops before the range end is saved.
  const savedOnFailure: number[] = [];
  await assert.rejects(catchUpWithSearch(10, 50, {
    findHeights: async () => [20, 30],
    processBlock: async (height) => { if (height === 30) throw new Error("QoreChain request failed with 500"); },
    saveHeight: async (height) => { savedOnFailure.push(height); },
  }));
  assert.deepEqual(savedOnFailure, [20]);
});

test("trusts the event search only when it finds an AMM event we already know about", async () => {
  // Pool 1 was created at Diana height 9003548.
  const indexCovers = async (from: number, to: number) => [9003548, 9003794].filter((height) => height >= from && height <= to);
  const indexMissesAmm = async () => [] as number[];
  assert.equal(await verifyEventSearch(9003548, indexCovers), true);
  assert.equal(await verifyEventSearch(9003548, indexMissesAmm), false);
  assert.equal(await verifyEventSearch(null, indexCovers), false);
  await assert.rejects(verifyEventSearch(9003548, async () => { throw new Error("QoreChain request failed with 500"); }));
});
