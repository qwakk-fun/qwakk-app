import assert from "node:assert/strict";
import test from "node:test";

import { changeBadge, favoritePoolIds, formatCompactAmount, formatListPrice, initialPoolsTab, poolsList, poolsSummary, sortPools, type ListMarket } from "../lib/qwakk-pools-list";

function pool(id: number, symbol: string, fields: Partial<ListMarket> = {}): ListMarket {
  return {
    id: String(id),
    token_a: `erc20:0x${String(id).padStart(40, "0")}`,
    token_b: "uqor",
    token_a_symbol: symbol,
    token_b_symbol: "QOR",
    token_a_decimals: 6,
    token_b_decimals: 6,
    quote_side: "b",
    price_quote: "1",
    transactions_24h: 0,
    low_liquidity: false,
    ...fields,
  };
}

const markets = [
  pool(1, "FETH", { transactions_24h: 23, price_change_percent_24h: "6.4" }),
  pool(2, "FUSD", { transactions_24h: 47, price_change_percent_24h: "-61.4" }),
  pool(5, "DUST", { transactions_24h: 0, low_liquidity: true, price_change_percent_24h: null }),
  pool(6, "QWAKK", { transactions_24h: 30, price_change_percent_24h: "42.4" }),
  pool(7, "QCAT", { transactions_24h: 30, price_change_percent_24h: null }),
];
const ids = (list: readonly ListMarket[]) => list.map((market) => String(market.id));

test("orders pools by swaps, by age and by the size of the move", () => {
  // Pools 6 and 7 tie on swaps; the newer one comes first.
  assert.deepEqual(ids(sortPools(markets, "trending")), ["2", "7", "6", "1", "5"]);
  assert.deepEqual(ids(sortPools(markets, "newest")), ["7", "6", "5", "2", "1"]);
  // A fall counts as much as a rise; pools without a 24h change go last.
  assert.deepEqual(ids(sortPools(markets, "moves")), ["2", "6", "1", "7", "5"]);
  // The input is never reordered in place.
  assert.deepEqual(ids(markets), ["1", "2", "5", "6", "7"]);
});

test("splits low-liquidity pools off the list and keeps the search matcher", () => {
  const all = poolsList(markets, "", "trending");
  assert.deepEqual(ids(all.listed), ["2", "7", "6", "1"]);
  assert.deepEqual(ids(all.low), ["5"]);

  const qcat = poolsList(markets, "qca", "trending");
  assert.deepEqual(ids(qcat.listed), ["7"]);
  assert.deepEqual(qcat.low, []);

  // A pool number finds its pool, low liquidity or not.
  const dust = poolsList(markets, "#5", "newest");
  assert.deepEqual(dust.listed, []);
  assert.deepEqual(ids(dust.low), ["5"]);

  assert.deepEqual(poolsList(markets, "nothing here", "trending"), { listed: [], low: [] });
});

test("narrows favorites by the search but keeps their starred order", () => {
  const starred = ["7", "99", "1", "5"];
  assert.deepEqual(favoritePoolIds(starred, markets, ""), starred);
  assert.deepEqual(favoritePoolIds(starred, markets, "  "), starred);
  assert.deepEqual(favoritePoolIds(starred, markets, "qor"), ["7", "1", "5"]);
  assert.deepEqual(favoritePoolIds(starred, markets, "feth"), ["1"]);
});

test("opens on the remembered tab, with ?view=favorites first", () => {
  assert.equal(initialPoolsTab(null, null), "trending");
  assert.equal(initialPoolsTab("favorites", "newest"), "favorites");
  assert.equal(initialPoolsTab(null, "moves"), "moves");
  assert.equal(initialPoolsTab(null, "favorites"), "favorites");
  // What older visits stored, and anything unknown, opens Trending.
  assert.equal(initialPoolsTab(null, "all"), "trending");
  assert.equal(initialPoolsTab("table", "grid"), "trending");
});

test("adds up the pools and their swaps", () => {
  assert.deepEqual(poolsSummary(markets), { pools: 5, swaps24h: 130 });
  assert.deepEqual(poolsSummary([pool(1, "A", { transactions_24h: "12" }), pool(2, "B", { transactions_24h: null })]), { pools: 2, swaps24h: 12 });
  assert.deepEqual(poolsSummary([]), { pools: 0, swaps24h: 0 });
});

test("shortens volumes and pool values", () => {
  assert.equal(formatCompactAmount("555339.838752"), "555.34K");
  assert.equal(formatCompactAmount("10770153.378798"), "10.77M");
  assert.equal(formatCompactAmount("1554.856858"), "1,554.86");
  assert.equal(formatCompactAmount("0.2446"), "0.245");
  assert.equal(formatCompactAmount(0), "0");
  assert.equal(formatCompactAmount(null), null);
  assert.equal(formatCompactAmount(""), null);
  assert.equal(formatCompactAmount("-3"), null);
  assert.equal(formatCompactAmount("abc"), null);
});

test("keeps huge prices short and small prices exact enough", () => {
  assert.equal(formatListPrice(1115093912041.7163), "1.115T");
  assert.equal(formatListPrice(2_500_000), "2.5M");
  assert.equal(formatListPrice(1554.8568), "1,554.86");
  assert.equal(formatListPrice(0.010955029908944879), "0.01096");
});

test("states a 24h change with an arrow and a word, never color alone", () => {
  assert.deepEqual(changeBadge(42.432), { tone: "up", arrow: "▲", word: "up", text: "42.43%" });
  assert.deepEqual(changeBadge(-61.4255), { tone: "down", arrow: "▼", word: "down", text: "61.43%" });
  assert.deepEqual(changeBadge(1940.0404), { tone: "up", arrow: "▲", word: "up", text: "1,940.04%" });
  assert.deepEqual(changeBadge(0.001), { tone: "flat", arrow: "", word: "", text: "0%" });
  assert.equal(changeBadge(null), null);
  assert.equal(changeBadge(Number.NaN), null);
});
