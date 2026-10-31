import assert from "node:assert/strict";
import test from "node:test";

import { formatTokenAmount } from "../lib/qwakk-asset-resolve";
import { formatVisibleAmount } from "../lib/qwakk-assets";
import { faucetAmountsText } from "../lib/qwakk-faucet";
import {
  dustThreshold, formatQuotePrice, impliedPairPrice, localLiquidityReason, isLowLiquidity, lowLiquidityCopy, marketChange, marketPrice, marketReserves, marketSides, pairLabel,
  priceDifferencePercent, priceUnit, type QuoteMarket,
} from "../lib/qwakk-market-view";

const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
const FBTC = "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A";

function market(overrides: Partial<QuoteMarket>): QuoteMarket {
  return {
    token_a: FETH, token_b: "uqor", token_a_symbol: "fETH", token_b_symbol: "QOR", token_a_decimals: 18, token_b_decimals: 6,
    reserve_a: "0", reserve_b: "0", quote_side: "b", price_quote: null, spot_price_quote: null, low_liquidity: false, low_liquidity_reason: null,
    ...overrides,
  };
}

test("reads pool 1 as it is live: quote per base, flagged dust, never the raw ratio", () => {
  // /api/markets for pool 1 on 2026-10-31.
  const pool1 = market({ reserve_a: "980129", reserve_b: "1020319", price_quote: "1033700000000", spot_price_quote: "1041004806510.16", low_liquidity: true, low_liquidity_reason: "dust_reserve" });
  assert.equal(marketPrice(pool1), 1033700000000);
  assert.equal(priceUnit(pool1), "QOR per fETH");
  assert.equal(pairLabel(pool1), "fETH/QOR");
  assert.equal(isLowLiquidity(pool1), true);
  assert.match(lowLiquidityCopy("dust_reserve"), /tiny amount/);
  // 980129 wei of fETH is far below 0.0001, so it gets more digits instead of reading as 0.
  assert.deepEqual(marketReserves(pool1), { base: "0.0000000000009801 fETH", quote: "1.0203 QOR" });
});

test("orients a market whose quote is token A", () => {
  const flipped = market({ token_a: "uqor", token_b: FBTC, token_a_symbol: "QOR", token_b_symbol: "fBTC", token_a_decimals: 6, token_b_decimals: 8, quote_side: "a", reserve_a: "5000000", reserve_b: "100000" });
  assert.equal(marketSides(flipped).base.symbol, "fBTC");
  assert.equal(pairLabel(flipped), "fBTC/QOR");
  assert.deepEqual(marketReserves(flipped), { base: "0.001 fBTC", quote: "5 QOR" });
});

test("labels reserves with unknown decimals as base units", () => {
  const unknown = market({ token_a: "ibc/ABC", token_a_symbol: "XYZ", token_a_decimals: null, reserve_a: "9484" });
  assert.equal(marketReserves(unknown).base, "9484 XYZ base units");
});

test("falls back to the spot price and computes the 24h change in quote terms", () => {
  assert.equal(marketPrice(market({ spot_price_quote: "2.5" })), 2.5);
  assert.equal(marketPrice(market({})), null);
  assert.equal(marketChange(market({ price_change_percent_24h: "-3.5" })), -3.5);
  assert.equal(marketChange(market({ price_quote: "110", price_quote_24h_ago: "100" })), 10);
  assert.equal(marketChange(market({ price_quote: "110" })), null);
});

test("formats prices without collapsing small ones to zero", () => {
  assert.equal(formatQuotePrice(1033700000000), "1,033,700,000,000");
  assert.equal(formatQuotePrice(2.123456), "2.1235");
  assert.equal(formatQuotePrice(0.00000123456), "0.000001235");
});

test("never shows a non-zero amount as 0", () => {
  assert.equal(formatVisibleAmount("48000", 18, 6), "0.000000000000048");
  assert.equal(formatVisibleAmount("1", 18, 6), "0.000000000000000001");
  assert.equal(formatVisibleAmount("0", 18, 6), "0");
  assert.equal(formatVisibleAmount("1500000", 6, 6), "1.5");
  assert.equal(formatTokenAmount("48000", 18, "fETH"), "0.000000000000048 fETH");
});

test("implies a pair price through QOR or fUSD pools, skipping low-liquidity pools", () => {
  const ethQor = market({ price_quote: "2000" });
  const btcQor = market({ token_a: FBTC, token_a_symbol: "fBTC", token_a_decimals: 8, price_quote: "40000" });
  const usdQor = market({ token_a: FUSD, token_a_symbol: "fUSD", token_a_decimals: 6, price_quote: "2" });
  // fETH in fBTC through QOR: 2000 / 40000.
  assert.deepEqual(impliedPairPrice([ethQor, btcQor], FETH, FBTC), { price: 0.05, via: "uqor" });
  // A direct pool wins, in either orientation.
  assert.deepEqual(impliedPairPrice([ethQor], "uqor", FETH), { price: 1 / 2000, via: null });
  assert.equal(impliedPairPrice([usdQor], FUSD, "uqor")?.price, 2);
  // Low-liquidity pools never set a reference price.
  assert.equal(impliedPairPrice([{ ...ethQor, low_liquidity: true }, btcQor], FETH, FBTC), null);
  assert.equal(priceDifferencePercent(0.06, 0.05)?.toFixed(6), "20.000000");
  assert.equal(priceDifferencePercent(1, 0), null);
});

test("states the faucet amounts from the QoreChain docs", () => {
  assert.equal(faucetAmountsText(), "100 QOR, 1,000 fUSD, 0.5 fETH and 0.02 fBTC");
});

test("checks reserves locally with the indexer's dust rule, failing closed", () => {
  // Pool 1 live: 980129 wei of fETH is under 10^12 (one millionth of fETH).
  assert.equal(localLiquidityReason("980129", "1020319", 18, 6), "dust_reserve");
  assert.equal(dustThreshold(18), BigInt(10) ** BigInt(12));
  assert.equal(dustThreshold(6), BigInt(1000));
  assert.equal(dustThreshold(8), BigInt(1000));
  assert.equal(localLiquidityReason("999", "5000000", 6, 6), "dust_reserve");
  assert.equal(localLiquidityReason("1000", "1000", 6, 6), null);
  assert.equal(localLiquidityReason("0", "1000", 6, 6), "empty");
  assert.equal(localLiquidityReason(undefined, "1000", 6, 6), "empty");
  assert.equal(localLiquidityReason("5000", "5000", null, 6), "unknown_decimals");
});
