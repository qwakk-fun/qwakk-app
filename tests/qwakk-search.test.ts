import assert from "node:assert/strict";
import test from "node:test";

import { marketSearchEntry, type QuoteMarket } from "../lib/qwakk-market-view";
import { isTokenLookup, matchedToken, parseSearchQuery, searchEmptyCopy, searchPools, shortQuery, type SearchEntry } from "../lib/qwakk-search";

const QWAKK = "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";
const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";

const qor = { denom: "uqor", symbol: "QOR", name: "QoreChain" };
const pools: SearchEntry[] = [
  { id: "1", tokens: [{ denom: FETH, symbol: "fETH", name: "FestETH" }, qor] },
  { id: "2", tokens: [{ denom: FUSD, symbol: "fUSD", name: "FestUSD" }, qor] },
  { id: "4", tokens: [{ denom: ATOM, symbol: "ATOM", name: "Cosmos Hub ATOM" }, qor] },
  { id: "6", tokens: [{ denom: QWAKK, symbol: "QWAKK", name: "Qwakk" }, qor] },
  { id: "7", tokens: [{ denom: QWAKK, symbol: "QWAKK", name: "Qwakk" }, { denom: FUSD, symbol: "fUSD", name: "FestUSD" }] },
];
const ids = (query: string) => searchPools(pools, query, (pool) => pool).map((match) => match.item.id);

test("parses addresses, denoms, pool numbers and text", () => {
  assert.deepEqual(parseSearchQuery("  "), { kind: "empty" });
  assert.deepEqual(parseSearchQuery("0xA5B3C3FB92E2E89555F9909B9004C65F3542EE23"), { kind: "address", address: "0xa5b3c3fb92e2e89555f9909b9004c65f3542ee23" });
  assert.deepEqual(parseSearchQuery(` "${QWAKK}" `), { kind: "address", address: "0xa5b3c3fb92e2e89555f9909b9004c65f3542ee23" });
  assert.deepEqual(parseSearchQuery(ATOM.toLowerCase()), { kind: "denom", denom: ATOM.toLowerCase() });
  assert.deepEqual(parseSearchQuery("#06"), { kind: "id", id: "6", terms: ["#06"] });
  assert.deepEqual(parseSearchQuery("QWAKK/QOR"), { kind: "text", terms: ["qwakk", "qor"] });
  assert.equal(isTokenLookup(parseSearchQuery("0x1234")), false);
});

test("finds pools by symbol and name, best match first", () => {
  assert.deepEqual(ids("qwakk"), ["6", "7"]);
  assert.deepEqual(ids("fest"), ["1", "2", "7"]);
  assert.deepEqual(ids("cosmos"), ["4"]);
  // QOR is in every pool here except 7; an exact symbol beats a name prefix.
  assert.deepEqual(ids("qor"), ["1", "2", "4", "6"]);
  assert.deepEqual(ids("nothing"), []);
});

test("a pair query needs every term to land", () => {
  assert.deepEqual(ids("qwakk qor"), ["6"]);
  assert.deepEqual(ids("QWAKK/fUSD"), ["7"]);
});

test("a pool number wins over everything else", () => {
  assert.deepEqual(ids("6"), ["6"]);
  assert.deepEqual(ids("#2"), ["2"]);
  assert.deepEqual(ids("99"), []);
});

test("a pasted address matches in any case, with or without erc20:", () => {
  for (const query of [QWAKK, QWAKK.toLowerCase(), QWAKK.slice(6), QWAKK.slice(6).toUpperCase().replace("0X", "0x")]) {
    const matches = searchPools(pools, query, (pool) => pool);
    assert.deepEqual(matches.map((match) => match.item.id), ["6", "7"], query);
    assert.equal(matchedToken(matches)?.symbol, "QWAKK");
  }
  // Pool order is the caller's: the first listed pool with the token is the top result.
  assert.equal(searchPools([...pools].reverse(), QWAKK, (pool) => pool)[0].item.id, "7");
});

test("ibc denoms match whole, partial addresses match from four characters", () => {
  assert.deepEqual(ids(ATOM.toLowerCase()), ["4"]);
  assert.deepEqual(ids("0xa5b3"), ["6", "7"]);
  assert.deepEqual(ids("ibc/2739"), ["4"]);
  // An unlisted address matches nothing, not a partial pool.
  assert.deepEqual(ids("0x0000000000000000000000000000000000000001"), []);
});

test("an empty query keeps every item in order, and the limit applies", () => {
  assert.deepEqual(ids(""), ["1", "2", "4", "6", "7"]);
  assert.equal(searchPools(pools, "qor", (pool) => pool, 2).length, 2);
});

test("empty copy names an unknown address plainly, without inviting a listing", () => {
  const address = searchEmptyCopy("0x0000000000000000000000000000000000000001", "Qwakk");
  assert.equal(address.title, "Not listed on Qwakk yet");
  assert.doesNotMatch(`${address.title} ${address.body}`, /\u2014|list it|add it|submit|request/i);
  const text = searchEmptyCopy("dogecoin", "Qwakk");
  assert.equal(text.title, "No pools match “dogecoin”");
  assert.doesNotMatch(`${text.title} ${text.body}`, /\u2014/);
  assert.equal(shortQuery("0x0000000000000000000000000000000000000001").length, 24);
});

test("reads a market through its curated names", () => {
  const market: QuoteMarket & { id: number } = {
    id: 6, token_a: "uqor", token_b: QWAKK, token_a_symbol: "QOR", token_b_symbol: "QWAKK", token_a_decimals: 6, token_b_decimals: 6, quote_side: "a",
  };
  assert.deepEqual(marketSearchEntry(market), {
    id: "6",
    tokens: [{ denom: QWAKK, symbol: "QWAKK", name: "Qwakk" }, { denom: "uqor", symbol: "QOR", name: "QoreChain" }],
  });
});
