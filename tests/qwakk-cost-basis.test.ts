import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLedger, chooseQorPools, formatScaled, historicalRatio, historyWindow, pnlPercent, qorPerToken, qorPoolLowLiquidity, swapValueUqor, valuePortfolio,
  type CostBasisSwap, type LedgerEntry, type TokenMeta, type TokenPrice,
} from "../indexer/cost-basis";

const X = "erc20:0xtoken";
const FETH = "erc20:0xfeth";
const FUSD = "erc20:0xfusd";
const QOR = "uqor";

/** n whole tokens of a 6-decimal token, or n QOR in uqor. */
const u = (n: number) => String(BigInt(Math.round(n * 1_000_000)));
const buy = (denom: string, tokens: string, uqor: string): CostBasisSwap => ({ denomIn: QOR, amountIn: uqor, denomOut: denom, amountOut: tokens });
const sell = (denom: string, tokens: string, uqor: string): CostBasisSwap => ({ denomIn: denom, amountIn: tokens, denomOut: QOR, amountOut: uqor });

const meta = new Map<string, TokenMeta>([
  [X, { symbol: "X", decimals: 6 }],
  [FETH, { symbol: "fETH", decimals: 18 }],
  [FUSD, { symbol: "fUSD", decimals: 6 }],
]);

function price(denom: string, num: number | bigint, den: number | bigint, source: TokenPrice["source"] = "last_trade", lowLiquidity = false): [string, TokenPrice] {
  return [denom, { ratio: { num: BigInt(num), den: BigInt(den) }, poolId: "1", source, lowLiquidity }];
}

function portfolio(ledger: Map<string, LedgerEntry>, balances: Record<string, string>, prices: Array<[string, TokenPrice]> = []) {
  return valuePortfolio({ ledger, balances: new Map(Object.entries(balances)), prices: new Map(prices), meta });
}

test("averages the cost of several buys and values the holding at the current price", () => {
  const ledger = buildLedger([buy(X, u(100), u(50)), buy(X, u(100), u(150))]);
  const entry = ledger.get(X)!;
  assert.equal(entry.knownQty, BigInt(u(200)));
  assert.equal(entry.knownCost, BigInt(u(200)));
  assert.equal(entry.buys, 2);

  // 1.5 QOR per X is 3 uqor per 2 base units.
  const { tokens, totals } = portfolio(ledger, { [X]: u(200), [QOR]: u(5) }, [price(X, 3, 2)]);
  assert.equal(tokens.length, 1, "QOR is the unit of account and has no row");
  const [token] = tokens;
  assert.equal(token.averageCostQor, "1");
  assert.equal(token.price?.qorPerToken, "1.5");
  assert.equal(token.valueUqor, u(300));
  assert.equal(token.costBasisUqor, u(200));
  assert.equal(token.unrealizedPnlUqor, u(100));
  assert.equal(token.unrealizedPnlPercent, "50");
  assert.equal(token.costCoverage, "complete");
  assert.equal(totals.coverage, "complete");
  assert.equal(totals.unrealizedPnlUqor, u(100));
  assert.equal(totals.realizedPnlUqor, "0");
});

test("books realized PnL on a partial sell at the average cost", () => {
  const ledger = buildLedger([buy(X, u(100), u(50)), buy(X, u(100), u(150)), sell(X, u(50), u(100))]);
  const entry = ledger.get(X)!;
  assert.equal(entry.realizedPnl, BigInt(u(50)));
  assert.equal(entry.knownQty, BigInt(u(150)));
  assert.equal(entry.knownCost, BigInt(u(150)));

  const { tokens, totals } = portfolio(ledger, { [X]: u(150) }, [price(X, 1, 2)]);
  assert.equal(tokens[0].unrealizedPnlUqor, `-${u(75)}`);
  assert.equal(tokens[0].unrealizedPnlPercent, "-50");
  assert.equal(totals.realizedPnlUqor, u(50));
  assert.equal(totals.unrealizedPnlUqor, `-${u(75)}`);
});

test("a full exit clears the basis and a re-entry starts a fresh average", () => {
  const ledger = buildLedger([buy(X, u(10), u(10)), sell(X, u(10), u(4)), buy(X, u(10), u(30))]);
  const entry = ledger.get(X)!;
  assert.equal(entry.realizedPnl, -BigInt(u(6)));
  assert.equal(entry.knownQty, BigInt(u(10)));
  assert.equal(entry.knownCost, BigInt(u(30)));
  const { tokens } = portfolio(ledger, { [X]: u(10) });
  assert.equal(tokens[0].averageCostQor, "3");
  assert.equal(tokens[0].realizedPnlUqor, `-${u(6)}`);

  // Exited and holding nothing: the row stays for its realized PnL.
  const exited = portfolio(buildLedger([buy(X, u(10), u(10)), sell(X, u(10), u(12))]), {});
  assert.equal(exited.tokens[0].held, "0");
  assert.equal(exited.tokens[0].realizedPnlUqor, u(2));
  assert.equal(exited.tokens[0].unrealizedPnlUqor, null);
  assert.equal(exited.totals.coverage, "complete");
});

test("exact-out swaps count by their executed amounts, like exact-in swaps", () => {
  // MsgSwapExactOut asks for an output and the chain picks the input; the event
  // carries both executed amounts, so it is the same trade to the ledger.
  const exactIn = buildLedger([buy(X, u(7), "3500001"), sell(X, u(2), "1100000")]);
  const exactOut = buildLedger([{ denomOut: X, amountOut: u(7), denomIn: QOR, amountIn: "3500001" }, { denomOut: QOR, amountOut: "1100000", denomIn: X, amountIn: u(2) }]);
  assert.deepEqual(exactOut.get(X), exactIn.get(X));
});

test("values a non-QOR pair through the input token's QOR price at swap time", () => {
  // 100 fUSD at 2 QOR each buys 0.05 fETH: the fETH cost and the fUSD proceeds are 200 QOR.
  const swap: CostBasisSwap = { denomIn: FUSD, amountIn: u(100), denomOut: FETH, amountOut: "50000000000000000", priceIn: { num: BigInt(2), den: BigInt(1) }, priceOut: { num: BigInt(1), den: BigInt(1) } };
  assert.equal(swapValueUqor(swap), BigInt(u(200)), "the input side wins when both are priced");
  const ledger = buildLedger([buy(FUSD, u(100), u(150)), swap]);
  assert.equal(ledger.get(FUSD)!.realizedPnl, BigInt(u(50)));
  assert.equal(ledger.get(FETH)!.knownCost, BigInt(u(200)));

  const { tokens } = portfolio(ledger, { [FETH]: "50000000000000000" }, [price(FETH, 5000, 1_000_000_000_000)]);
  const feth = tokens.find((token) => token.denom === FETH)!;
  // 0.005 uqor per base unit is 5000 QOR per fETH; 0.05 fETH is worth 250 QOR.
  assert.equal(feth.price?.qorPerToken, "5000");
  assert.equal(feth.averageCostQor, "4000");
  assert.equal(feth.valueUqor, u(250));
  assert.equal(feth.unrealizedPnlUqor, u(50));
});

test("falls back to the output price, and marks the swap unknown without any QOR route", () => {
  const viaOutput: CostBasisSwap = { denomIn: FUSD, amountIn: u(100), denomOut: X, amountOut: u(10), priceIn: null, priceOut: { num: BigInt(3), den: BigInt(1) } };
  assert.equal(swapValueUqor(viaOutput), BigInt(u(30)));

  const noRoute: CostBasisSwap = { denomIn: FUSD, amountIn: u(100), denomOut: X, amountOut: u(10) };
  assert.equal(swapValueUqor(noRoute), null);
  const ledger = buildLedger([buy(FUSD, u(100), u(100)), noRoute]);
  const fusd = ledger.get(FUSD)!;
  const x = ledger.get(X)!;
  assert.equal(fusd.realizedPnl, BigInt(0), "no proceeds, no PnL");
  assert.equal(fusd.realizedUnknownQty, BigInt(u(100)));
  assert.equal(fusd.knownQty, BigInt(0), "the sold units still leave the position");
  assert.equal(x.unknownQty, BigInt(u(10)));
  assert.equal(x.knownQty, BigInt(0));

  const { tokens, totals } = portfolio(ledger, { [X]: u(10) }, [price(X, 2, 1)]);
  const row = tokens.find((token) => token.denom === X)!;
  assert.equal(row.unknownCostAmount, u(10));
  assert.equal(row.unrealizedPnlUqor, null, "unknown cost is never folded into PnL");
  assert.equal(row.valueUqor, u(20), "the holding is still valued");
  assert.equal(row.costCoverage, "none");
  assert.equal(totals.coverage, "none");
});

test("holdings without swap history and sells beyond the position have unknown cost", () => {
  // 50 X from the faucet, then 20 bought, then 30 sold.
  const ledger = buildLedger([buy(X, u(20), u(20)), sell(X, u(30), u(60))]);
  const entry = ledger.get(X)!;
  // 20 of the 30 sold had a basis: proceeds 40 against cost 20.
  assert.equal(entry.realizedPnl, BigInt(u(20)));
  assert.equal(entry.realizedQty, BigInt(u(20)));
  assert.equal(entry.realizedUnknownQty, BigInt(u(10)));

  const { tokens, totals } = portfolio(ledger, { [X]: u(40), [FUSD]: u(5) }, [price(X, 1, 1), price(FUSD, 1, 1)]);
  const x = tokens.find((token) => token.denom === X)!;
  assert.equal(x.costBasisAmount, "0");
  assert.equal(x.unknownCostAmount, u(40));
  assert.equal(x.unrealizedPnlUqor, null);
  assert.equal(x.costCoverage, "partial");
  const faucetOnly = tokens.find((token) => token.denom === FUSD)!;
  assert.equal(faucetOnly.bought, "0");
  assert.equal(faucetOnly.unknownCostAmount, u(5));
  assert.equal(faucetOnly.costCoverage, "none");
  assert.equal(totals.coverage, "partial");
  assert.equal(totals.realizedPnlUqor, u(20));
  assert.equal(totals.valueUqor, u(45));
  assert.equal(totals.unrealizedPnlPercent, null);
});

test("splits held units beyond the swap position into unknown cost", () => {
  const ledger = buildLedger([buy(X, u(10), u(10))]);
  const { tokens } = portfolio(ledger, { [X]: u(15) }, [price(X, 2, 1)]);
  assert.equal(tokens[0].costBasisAmount, u(10));
  assert.equal(tokens[0].unknownCostAmount, u(5));
  assert.equal(tokens[0].valueUqor, u(30));
  assert.equal(tokens[0].unrealizedPnlUqor, u(10), "only the known 10 count: worth 20, cost 10");
  assert.equal(tokens[0].costCoverage, "partial");
});

test("units that left the wallet without a sale keep the average and are not realized", () => {
  // Bought 100, then 40 went into a pool or were sent away.
  const ledger = buildLedger([buy(X, u(100), u(200))]);
  const { tokens, totals } = portfolio(ledger, { [X]: u(60) }, [price(X, 3, 1)]);
  assert.equal(tokens[0].untrackedOutflowAmount, u(40));
  assert.equal(tokens[0].costBasisAmount, u(60));
  assert.equal(tokens[0].costBasisUqor, u(120));
  assert.equal(tokens[0].averageCostQor, "2");
  assert.equal(tokens[0].unrealizedPnlUqor, u(60));
  assert.equal(tokens[0].realizedPnlUqor, "0");
  assert.equal(totals.coverage, "complete");
});

test("dust: integer splits conserve the basis and a full exit leaves nothing behind", () => {
  // 3 base units for 10 uqor, sold one at a time.
  const ledger = buildLedger([buy(X, "3", "10"), sell(X, "1", "4")]);
  let entry = ledger.get(X)!;
  assert.equal(entry.knownCost, BigInt(7), "10 * 1 / 3 truncates to 3 removed, 7 stays");
  assert.equal(entry.realizedPnl, BigInt(1));
  const after = buildLedger([buy(X, "3", "10"), sell(X, "1", "4"), sell(X, "2", "8")]);
  entry = after.get(X)!;
  assert.equal(entry.knownQty, BigInt(0));
  assert.equal(entry.knownCost, BigInt(0));
  assert.equal(entry.realizedPnl, BigInt(2), "total proceeds 12 minus total cost 10, exactly");

  const { tokens } = portfolio(buildLedger([buy(X, "500", "1")]), { [X]: "500" }, [price(X, 1, 1000)]);
  assert.equal(tokens[0].dust, true);
  assert.equal(tokens[0].valueUqor, "0", "values truncate to whole uqor");
  assert.equal(tokens[0].unrealizedPnlUqor, "-1");
  assert.equal(tokens[0].unrealizedPnlPercent, "-100");
});

test("stays exact on 18-decimal amounts beyond the float range", () => {
  const big = "123456789012345678901234567";
  const ledger = buildLedger([{ denomIn: QOR, amountIn: "987654321987654321", denomOut: FETH, amountOut: big }]);
  const { tokens } = portfolio(ledger, { [FETH]: big }, [price(FETH, BigInt("987654321987654321") * BigInt(3), BigInt(big))]);
  assert.equal(tokens[0].costBasisUqor, "987654321987654321");
  assert.equal(tokens[0].valueUqor, (BigInt("987654321987654321") * BigInt(3)).toString());
  assert.equal(tokens[0].unrealizedPnlUqor, (BigInt("987654321987654321") * BigInt(2)).toString());
  assert.equal(tokens[0].unrealizedPnlPercent, "200");
});

test("leaves tokens without known decimals unpriced, as the markets page does", () => {
  const unknown = "ibc/unknown";
  const ledger = buildLedger([buy(unknown, "1000", "1000")]);
  const { tokens, totals } = portfolio(ledger, { [unknown]: "1000" }, [price(unknown, 2, 1)]);
  assert.equal(tokens[0].price, null);
  assert.equal(tokens[0].valueUqor, null);
  assert.equal(tokens[0].averageCostQor, null);
  assert.equal(tokens[0].costBasisUqor, "1000", "the basis in uqor needs no decimals");
  assert.equal(totals.unpricedTokens, 1);
  assert.equal(totals.coverage, "partial");
});

test("sorts by current value, unpriced last, and reports an empty wallet as none", () => {
  const ledger = buildLedger([buy(X, u(1), u(1)), buy(FUSD, u(1), u(1))]);
  const { tokens } = portfolio(ledger, { [X]: u(1), [FUSD]: u(1), [FETH]: "1" }, [price(X, 1, 1), price(FUSD, 5, 1)]);
  assert.deepEqual(tokens.map((token) => token.denom), [FUSD, X, FETH]);
  const empty = portfolio(new Map(), { [QOR]: u(10) });
  assert.deepEqual(empty.tokens, []);
  assert.equal(empty.totals.coverage, "none");
  assert.equal(empty.totals.valueUqor, "0");
});

test("formats signed scaled values and percentages exactly", () => {
  assert.equal(formatScaled(BigInt(-1500000), 6), "-1.5");
  assert.equal(formatScaled(BigInt(7), 6), "0.000007");
  assert.equal(formatScaled(BigInt(0), 6), "0");
  assert.equal(pnlPercent(BigInt(-1), BigInt(3)), "-33.33");
  assert.equal(pnlPercent(BigInt(1), BigInt(0)), null);
  assert.equal(qorPerToken(BigInt(1), BigInt(3), 6), "0.333333333333333333");
  assert.equal(qorPerToken(BigInt(1), BigInt(3), null), null);
});

test("picks the QOR pool with the deepest QOR reserve per token", () => {
  const pools = chooseQorPools([
    { id: "4", tokenA: X, tokenB: QOR, reserveA: u(1), reserveB: u(10) },
    { id: "2", tokenA: QOR, tokenB: X, reserveA: u(500), reserveB: u(5) },
    { id: "3", tokenA: X, tokenB: QOR, reserveA: null, reserveB: null },
    { id: "5", tokenA: FETH, tokenB: FUSD, reserveA: "1", reserveB: "1" },
    { id: "6", tokenA: FUSD, tokenB: QOR, reserveA: u(1), reserveB: u(1) },
    { id: "7", tokenA: FUSD, tokenB: QOR, reserveA: u(1), reserveB: u(1) },
  ]);
  assert.equal(pools.get(X)?.id, "2");
  assert.equal(pools.get(FUSD)?.id, "6", "lowest id on a tie");
  assert.equal(pools.has(FETH), false, "no QOR route");

  const healthyFirst = chooseQorPools([
    { id: "1", tokenA: FETH, tokenB: QOR, reserveA: "969699", reserveB: u(900000), lowLiquidity: true },
    { id: "8", tokenA: FETH, tokenB: QOR, reserveA: "1000000000000000000", reserveB: u(20), lowLiquidity: false },
  ]);
  assert.equal(healthyFirst.get(FETH)?.id, "8", "a healthy pool beats a deeper low-liquidity one");
  const onlyDust = chooseQorPools([{ id: "1", tokenA: FETH, tokenB: QOR, reserveA: "969699", reserveB: "1031359", lowLiquidity: true }]);
  assert.equal(onlyDust.get(FETH)?.lowLiquidity, true, "still chosen, so its price can be shown as unused");
});

test("takes the newer of the last trade and the reserve snapshot for a past price", () => {
  const trade = { denomIn: QOR, amountIn: u(2), denomOut: X, amountOut: u(1) };
  const reserves = { tokenA: X, tokenB: QOR, reserveA: u(10), reserveB: u(30) };
  assert.deepEqual(historicalRatio(X, trade, reserves, false, true), { num: BigInt(u(2)), den: BigInt(u(1)) });
  assert.deepEqual(historicalRatio(X, trade, reserves, true, true), { num: BigInt(u(30)), den: BigInt(u(10)) });
  assert.deepEqual(historicalRatio(X, null, reserves, false, true), { num: BigInt(u(30)), den: BigInt(u(10)) });
  assert.equal(historicalRatio(X, null, { ...reserves, reserveA: "0" }, false, true), null);
  assert.equal(historicalRatio(X, null, null, false, true), null);
  assert.equal(historicalRatio(X, trade, reserves, false, false), null, "a pool that was low liquidity then prices nothing");
});

test("a low-liquidity price is shown but never values a holding or enters the totals", () => {
  // The live case: fETH's only QOR pool is dust and quotes about 1e12 QOR per fETH.
  const ledger = buildLedger([buy(FETH, "878407625571210", "20197987"), buy(X, u(10), u(10))]);
  const { tokens, totals } = portfolio(ledger, { [FETH]: "350878407625571210", [X]: u(10) }, [price(FETH, 1031359, 969699, "last_trade", true), price(X, 2, 1)]);
  const feth = tokens.find((token) => token.denom === FETH)!;
  assert.equal(feth.price?.lowLiquidity, true);
  assert.equal(feth.price?.qorPerToken, "1063586741865.259219613508934215", "kept for display");
  assert.equal(feth.valueUqor, null);
  assert.equal(feth.unrealizedPnlUqor, null);
  assert.equal(feth.unrealizedPnlPercent, null);
  assert.equal(feth.averageCostQor, "22993.865731602311575393", "the executed cost is untouched");
  assert.equal(totals.unpricedTokens, 1);
  assert.equal(totals.valueUqor, u(20), "only X counts");
  assert.equal(totals.costBasisUqor, u(10));
  assert.equal(totals.unrealizedPnlUqor, u(10));
  assert.equal(totals.unrealizedPnlPercent, "100");
  assert.equal(totals.coverage, "partial");
  assert.deepEqual(tokens.map((token) => token.denom), [X, FETH], "unpriced rows sort last");
});

test("a swap made directly in a dust QOR pool keeps its executed QOR cost", () => {
  // Real amounts at a silly price: 50 QOR for 1 base unit. Honest, so it stays.
  const ledger = buildLedger([buy(FETH, "1", u(50))]);
  assert.equal(ledger.get(FETH)!.knownCost, BigInt(u(50)));
});

test("applies the markets page's low-liquidity rule to QOR pools", () => {
  const pool = (reserveA: string, reserveB: string, decimalsA: number | null = 18) =>
    qorPoolLowLiquidity({ poolType: "constant_product", tokenA: FETH, tokenB: QOR, reserveA, reserveB, decimalsA, decimalsB: 6, minTvl: "10" });
  // Live pool 1 (fETH/QOR): 969699 fETH base units is far below one millionth of an 18-decimal token.
  assert.equal(pool("969699", "1031359"), true);
  assert.equal(pool("1000000000000000000", u(6000)), false);
  assert.equal(pool("1000000000000000000", u(4)), true, "TVL 8 QOR is under the 10 QOR minimum");
  assert.equal(pool("1000000000000000000", "0"), true);
  assert.equal(pool("1000000000000000000", null as unknown as string), true);
  assert.equal(pool("1000000000000000000", u(6000), null), true, "unknown decimals");
  // Live pool 2 (QOR/fUSD) is healthy.
  assert.equal(qorPoolLowLiquidity({ poolType: "constant_product", tokenA: FUSD, tokenB: QOR, reserveA: "451451509", reserveB: "10059913737", decimalsA: 6, decimalsB: 6, minTvl: "10" }), false);
});

test("reports where indexed history starts and any pruned gap", () => {
  assert.deepEqual(
    historyWindow({ startHeight: 9000001, earliestEventHeight: 9000500, earliestEventTime: "2026-11-01T00:00:00.000Z", prunedGap: "9100000-9100500", indexedHeight: 9300000 }),
    { fromHeight: 9000001, fromTime: "2026-11-01T00:00:00.000Z", source: "indexer_start", indexedHeight: 9300000, gap: { fromHeight: 9100000, toHeight: 9100500 } },
  );
  const older = historyWindow({ startHeight: null, earliestEventHeight: 9000500, earliestEventTime: null, prunedGap: null, indexedHeight: null });
  assert.equal(older.fromHeight, 9000500);
  assert.equal(older.source, "earliest_event");
  assert.equal(older.gap, null);
  assert.equal(historyWindow({ startHeight: null, earliestEventHeight: null, earliestEventTime: null, prunedGap: null, indexedHeight: 5 }).source, null);
});
