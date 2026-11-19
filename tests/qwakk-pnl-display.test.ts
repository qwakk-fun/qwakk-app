import assert from "node:assert/strict";
import test from "node:test";

import {
  PNL_ERROR_COPY,
  formatPnlDay,
  formatPnlPercent,
  formatQor,
  formatQorPerToken,
  formatSignedQor,
  formatTokenAmount,
  groupDigits,
  hasLowLiquidityPrice,
  parsePnlReport,
  pnlErrorKind,
  pnlHistoryLine,
  pnlTone,
  splitDust,
  type PnlToken,
} from "../lib/qwakk-pnl-display";

const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";

function token(overrides: Partial<PnlToken> = {}): PnlToken {
  return {
    denom: FUSD, symbol: "fUSD", decimals: 6, held: "200000000", bought: "250000000", sold: "50000000", buys: 2, sells: 1,
    costBasisAmount: "200000000", costBasisUqor: "200000000", averageCostQor: "1", unknownCostAmount: "0", untrackedOutflowAmount: "0",
    price: { qorPerToken: "1.5", poolId: "2", source: "last_trade", lowLiquidity: false }, valueUqor: "300000000",
    unrealizedPnlUqor: "100000000", unrealizedPnlPercent: "50", realizedPnlUqor: "50000000", realizedUnknownAmount: "0",
    costCoverage: "complete", dust: false, ...overrides,
  };
}

const body = {
  address: "qor1example",
  method: "average_cost",
  unit: { denom: "uqor", symbol: "QOR", decimals: 6 },
  history: { fromHeight: 9000001, fromTime: "2026-11-12T08:14:03.512Z", source: "indexer_start", indexedHeight: 9300000, gap: null },
  swapsCounted: 3,
  totals: { valueUqor: "300000000", costBasisUqor: "200000000", unrealizedPnlUqor: "100000000", unrealizedPnlPercent: "50", realizedPnlUqor: "50000000", unpricedTokens: 0, coverage: "complete" },
  tokens: [token()],
};

test("formats QOR from uqor exactly, truncated, with a sign for results", () => {
  assert.equal(formatQor("0"), "0");
  assert.equal(formatQor("1"), "0.000001");
  assert.equal(formatQor("1500000"), "1.5");
  assert.equal(formatQor("123456789"), "123.4567");
  assert.equal(formatQor("1234567891234"), "1,234,567.89");
  // Far beyond float precision: still exact.
  assert.equal(formatQor("9007199254740993123456"), "9,007,199,254,740,993.12");
  assert.equal(formatQor("-2500000"), "2.5");
  assert.equal(formatQor("bad"), "0");
  assert.equal(formatQor(null), "0");
  assert.equal(formatSignedQor("100000000"), "+100");
  assert.equal(formatSignedQor("-250000"), "−0.25");
  assert.equal(formatSignedQor("-1"), "−0.000001");
  assert.equal(formatSignedQor("0"), "0");
  assert.equal(formatSignedQor("-0"), "0");
});

test("tells gains, losses and zero apart", () => {
  assert.equal(pnlTone("5"), "up");
  assert.equal(pnlTone("-5"), "down");
  assert.equal(pnlTone("0"), "flat");
  assert.equal(pnlTone("-0.00"), "flat");
  assert.equal(pnlTone("0.01"), "up");
  assert.equal(pnlTone(null), "flat");
  assert.equal(pnlTone("1e5"), "flat");
});

test("formats percent changes with an arrow and a word, not color alone", () => {
  assert.deepEqual(formatPnlPercent("50"), { tone: "up", arrow: "▲", word: "up", text: "50%" });
  assert.deepEqual(formatPnlPercent("-12.5"), { tone: "down", arrow: "▼", word: "down", text: "12.5%" });
  assert.deepEqual(formatPnlPercent("0"), { tone: "flat", arrow: "", word: "", text: "0%" });
  assert.equal(formatPnlPercent("1234.567")?.text, "1,234.56%");
  assert.equal(formatPnlPercent("0.10")?.text, "0.1%");
  assert.equal(formatPnlPercent(null), null);
  assert.equal(formatPnlPercent("NaN"), null);
});

test("formats token amounts without float drift, also for 18 decimal tokens", () => {
  assert.equal(formatTokenAmount("200000000", 6), "200");
  assert.equal(formatTokenAmount("1234567890123456789012", 18), "1,234.5678");
  assert.equal(formatTokenAmount("123456789012345678", 18), "0.1234");
  // A tiny but non-zero balance never reads as 0.
  assert.equal(formatTokenAmount("48000", 18), "0.000000000000048");
  assert.equal(formatTokenAmount("0", 18), "0");
  assert.equal(formatTokenAmount("1234567", null), "1,234,567 base units");
  assert.equal(formatTokenAmount("-5", 6), "0");
});

test("formats QOR per token from exact decimal strings", () => {
  assert.equal(formatQorPerToken("1"), "1");
  assert.equal(formatQorPerToken("1.500000000000000000"), "1.5");
  assert.equal(formatQorPerToken("12.345678912345678912"), "12.3456");
  assert.equal(formatQorPerToken("12345.678"), "12,345.67");
  assert.equal(formatQorPerToken("0.000000001234567891"), "0.000000001234");
  assert.equal(formatQorPerToken("0.000000000000000001"), "0.000000000000000001");
  assert.equal(formatQorPerToken("0"), "0");
  assert.equal(formatQorPerToken("0.000000000000000000"), "0");
  assert.equal(formatQorPerToken(null), null);
  assert.equal(formatQorPerToken("abc"), null);
  assert.equal(groupDigits("1234567.1234"), "1,234,567.1234");
});

test("writes the history line from the first indexed time", () => {
  assert.equal(formatPnlDay("2026-11-12T08:14:03.512Z"), "Nov 12, 2026");
  assert.equal(formatPnlDay("nope"), null);
  assert.equal(pnlHistoryLine({ fromTime: "2026-11-12T23:59:59Z" }), "Counting swaps since Nov 12, 2026");
  assert.equal(pnlHistoryLine({ fromTime: null }), "Counting every swap we have on record");
});

test("parses a valid report and keeps its exact strings", () => {
  const report = parsePnlReport(body);
  assert.ok(report);
  assert.equal(report.swapsCounted, 3);
  assert.equal(report.totals.coverage, "complete");
  assert.equal(report.tokens.length, 1);
  assert.equal(report.tokens[0].averageCostQor, "1");
  assert.equal(report.tokens[0].price?.qorPerToken, "1.5");
  assert.equal(report.history.fromTime, "2026-11-12T08:14:03.512Z");
});

test("accepts unknown tokens, unpriced tokens and negative results", () => {
  const unknown = token({ denom: "factory/x/odd", symbol: null, decimals: null, price: null, valueUqor: null, unrealizedPnlUqor: null, unrealizedPnlPercent: null, averageCostQor: null, realizedPnlUqor: "-42", costCoverage: "partial" });
  const report = parsePnlReport({ ...body, tokens: [unknown] });
  assert.ok(report);
  assert.equal(report.tokens[0].decimals, null);
  assert.equal(report.tokens[0].symbol, null);
  assert.equal(report.tokens[0].price, null);
  assert.equal(report.tokens[0].realizedPnlUqor, "-42");
});

test("rejects broken totals and drops broken rows as partial coverage", () => {
  assert.equal(parsePnlReport(null), null);
  assert.equal(parsePnlReport({ error: "Profit and loss is temporarily unavailable" }), null);
  assert.equal(parsePnlReport({ ...body, totals: { ...body.totals, valueUqor: 3.5 } }), null);
  assert.equal(parsePnlReport({ ...body, totals: { ...body.totals, coverage: "most" } }), null);
  assert.equal(parsePnlReport({ ...body, tokens: "none" }), null);
  const report = parsePnlReport({ ...body, tokens: [token(), token({ denom: FETH, held: "1.5" })] });
  assert.ok(report);
  assert.equal(report.tokens.length, 1);
  assert.equal(report.totals.coverage, "partial");
});

test("puts small balances behind the toggle and spots low-liquidity prices", () => {
  const dust = token({ denom: FETH, symbol: "fETH", decimals: 18, held: "1000", dust: true });
  const { main, dust: small } = splitDust([token(), dust]);
  assert.deepEqual(main.map((row) => row.denom), [FUSD]);
  assert.deepEqual(small.map((row) => row.denom), [FETH]);
  assert.equal(hasLowLiquidityPrice([token()]), false);
  assert.equal(hasLowLiquidityPrice([token({ price: { qorPerToken: "2", poolId: "9", source: "spot", lowLiquidity: true } })]), true);
  // A sold-out token's thin pool does not move anything the wallet holds.
  assert.equal(hasLowLiquidityPrice([token({ held: "0", price: { qorPerToken: "2", poolId: "9", source: "spot", lowLiquidity: true } })]), false);
});

test("maps every failure to fixed copy without em dashes", () => {
  assert.equal(pnlErrorKind(422), "busy");
  assert.equal(pnlErrorKind(503), "unavailable");
  assert.equal(pnlErrorKind(400), "unavailable");
  assert.equal(pnlErrorKind(null), "unavailable");
  for (const copy of Object.values(PNL_ERROR_COPY)) {
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /\u2014/);
  }
});
