import assert from "node:assert/strict";
import test from "node:test";

import {
  marketPairCandidate,
  marketPairSlugs,
  matchSymbols,
  pairSlug,
  pairSlugsById,
  parsePairParam,
  poolPath,
  resolvePairParam,
  swapPath,
  swapPathFor,
  symbolSlug,
  type PairCandidate,
} from "../lib/qwakk-pair-slug";

const QWAKK = "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";
const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";

const qor = { denom: "uqor", symbol: "QOR" };
const pool = (id: string, base: { denom: string; symbol: string }, quote: { denom: string; symbol: string }, liquidity: number | null): PairCandidate => ({ id, base, quote, liquidity });

// The live Diana pools on 2026-11-25, base first as the app shows them.
const pools: PairCandidate[] = [
  pool("1", { denom: FETH, symbol: "fETH" }, qor, 2),
  pool("2", { denom: FUSD, symbol: "fUSD" }, qor, 26_640),
  pool("3", { denom: FETH, symbol: "fETH" }, { denom: FUSD, symbol: "fUSD" }, 1_085),
  pool("6", { denom: QWAKK, symbol: "QWAKK" }, qor, 699_526),
];

test("slugs are the lowercased symbols, base first", () => {
  assert.equal(symbolSlug("fUSD"), "fusd");
  assert.equal(symbolSlug("USDC.e"), "usdce");
  assert.equal(symbolSlug("<script>"), "script");
  assert.equal(symbolSlug("$$"), "");
  assert.equal(pairSlug("QWAKK", "QOR"), "qwakk-qor");
  assert.equal(pairSlug("QOR", "qor"), null);
  assert.equal(pairSlug("", "QOR"), null);
  assert.deepEqual([...pairSlugsById(pools)], [["1", "feth-qor"], ["2", "fusd-qor"], ["3", "feth-fusd"], ["6", "qwakk-qor"]]);
});

test("parses ids and pairs case-insensitively and rejects anything else", () => {
  assert.deepEqual(parsePairParam("6"), { kind: "id", id: "6" });
  assert.deepEqual(parsePairParam("006"), { kind: "id", id: "6" });
  assert.deepEqual(parsePairParam("0"), { kind: "invalid" });
  assert.deepEqual(parsePairParam("QWAKK-QOR"), { kind: "pair", first: "qwakk", second: "qor" });
  assert.deepEqual(parsePairParam("qwakk%2Dqor"), { kind: "pair", first: "qwakk", second: "qor" });
  for (const bad of ["nope", "qwakk-qor-6", "qwakk-", "-qor", "qor-qor", "qwakk/qor", "%E0%A4%A", "<b>-qor", "a".repeat(33) + "-qor", ""]) {
    assert.deepEqual(parsePairParam(bad), { kind: "invalid" }, bad);
  }
});

test("a pair opens its pool in either order, and the order is the swap direction", () => {
  const sell = resolvePairParam("qwakk-qor", pools);
  assert.equal(sell?.pool.id, "6");
  assert.equal(sell?.poolSlug, "qwakk-qor");
  assert.equal(sell?.swapSlug, "qwakk-qor");
  assert.equal(sell?.payDenom, QWAKK);
  assert.deepEqual(sell && matchSymbols(sell), { base: "QWAKK", quote: "QOR", pay: "QWAKK", receive: "QOR" });

  const buy = resolvePairParam("QOR-QWAKK", pools);
  assert.equal(buy?.pool.id, "6");
  assert.equal(buy?.poolSlug, "qwakk-qor");
  assert.equal(buy?.swapSlug, "qor-qwakk");
  assert.equal(buy?.payDenom, "uqor");
  assert.deepEqual(buy && matchSymbols(buy), { base: "QWAKK", quote: "QOR", pay: "QOR", receive: "QWAKK" });

  assert.equal(resolvePairParam("fusd-feth", pools)?.pool.id, "3");
});

test("a numeric id opens exactly that pool and pays with its base token", () => {
  const match = resolvePairParam("6", pools);
  assert.equal(match?.pool.id, "6");
  assert.equal(match?.poolSlug, "qwakk-qor");
  assert.equal(match?.swapSlug, "qwakk-qor");
  assert.equal(match?.payDenom, QWAKK);
});

test("unknown pairs, ids and junk match nothing", () => {
  assert.equal(resolvePairParam("nope", pools), null);
  assert.equal(resolvePairParam("qcat-qor", pools), null);
  assert.equal(resolvePairParam("99", pools), null);
  assert.equal(resolvePairParam("qwakk-fusd", pools), null);
  assert.equal(resolvePairParam("qwakk-qor", []), null);
});

test("a newly curated token gets its slug from its symbol with no extra setup", () => {
  const QCAT = "erc20:0x0000000000000000000000000000000000000c47";
  const curated = new Map([...pools.flatMap((entry) => [entry.base, entry.quote]), { denom: QCAT, symbol: "QCAT" }].map((token) => [token.denom, token]));
  const lookup = (denom: string) => curated.get(denom);
  const withQcat = [...pools, pool("7", { denom: QCAT, symbol: "QCAT" }, qor, 10)];
  assert.equal(resolvePairParam("qcat-qor", withQcat, lookup)?.pool.id, "7");
  assert.equal(swapPath("7", pairSlugsById(withQcat, lookup)), "/swap/qcat-qor");
  // Not curated yet: the pool keeps its id links.
  assert.equal(resolvePairParam("qcat-qor", withQcat, () => undefined), null);
  assert.equal(swapPath("7", pairSlugsById(withQcat, (denom) => denom === QCAT ? undefined : curated.get(denom))), "/swap?pool=7");
});

test("look-alike tokens never take a readable link, however deep their pool", () => {
  const FAKE_QWAKK = "erc20:0x1111111111111111111111111111111111111111";
  const FAKE_QOR = "erc20:0x2222222222222222222222222222222222222222";
  const fakes = [
    ...pools,
    pool("20", { denom: FAKE_QWAKK, symbol: "QWAKK." }, { denom: FAKE_QOR, symbol: "QOR" }, 1e15),
    pool("21", { denom: FAKE_QWAKK, symbol: "QWAKK" }, qor, 1e15),
    pool("22", { denom: QWAKK.toLowerCase(), symbol: "QWAKK" }, qor, 1e15),
  ];
  for (const slug of ["qwakk-qor", "qor-qwakk", "QWAKK-QOR"]) assert.equal(resolvePairParam(slug, fakes)?.pool.id, "6", slug);
  const slugs = pairSlugsById(fakes);
  assert.equal(poolPath("6", slugs), "/pools/qwakk-qor");
  for (const id of ["20", "21", "22"]) {
    assert.equal(poolPath(id, slugs), `/pools/${id}`);
    assert.equal(swapPath(id, slugs), `/swap?pool=${id}`);
    const exact = resolvePairParam(id, fakes);
    assert.equal(exact?.pool.id, id);
    assert.equal(exact?.poolSlug, null);
  }
});

test("liquidity only decides between pools counted in the same quote token", () => {
  // Same curated pair, but the indexer quotes pool 31 in QWAKK: its figure is not comparable, so the older pool wins.
  const flipped = [pools[3], pool("31", qor, { denom: QWAKK, symbol: "QWAKK" }, 1e12)];
  assert.equal(resolvePairParam("qwakk-qor", flipped)?.pool.id, "6");
  assert.equal(resolvePairParam("qor-qwakk", flipped)?.payDenom, "uqor");
});

test("two pools with one pair: the deeper pool owns the slug, the other keeps its id", () => {
  const dup = [...pools, pool("8", { denom: QWAKK, symbol: "QWAKK" }, qor, 900_000), pool("9", { denom: QWAKK, symbol: "QWAKK" }, qor, null)];
  assert.equal(resolvePairParam("qwakk-qor", dup)?.pool.id, "8");
  const slugs = pairSlugsById(dup);
  assert.equal(poolPath("8", slugs), "/pools/qwakk-qor");
  assert.equal(poolPath("6", slugs), "/pools/6");
  assert.equal(swapPath("6", slugs), "/swap?pool=6");
  // The id stays the exact way in: no slug to move to, so no redirect.
  const exact = resolvePairParam("6", dup);
  assert.equal(exact?.pool.id, "6");
  assert.equal(exact?.poolSlug, null);
  assert.equal(exact?.swapSlug, null);
  // Equal liquidity: the older pool wins.
  const tie = [pool("12", { denom: FETH, symbol: "fETH" }, qor, 5), pool("11", { denom: FETH, symbol: "fETH" }, qor, 5)];
  assert.equal(resolvePairParam("feth-qor", tie)?.pool.id, "11");
});

test("paths fall back to the id for pools without a usable slug", () => {
  const odd = [pool("4", { denom: "ibc/ABC", symbol: "$$" }, qor, 1)];
  const slugs = pairSlugsById(odd);
  assert.equal(poolPath("4", slugs), "/pools/4");
  assert.equal(swapPath("4", slugs), "/swap?pool=4");
  assert.equal(resolvePairParam("4", odd)?.poolSlug, null);
});

test("swap links follow the paid token", () => {
  const slugs = pairSlugsById(pools);
  const qwakk = pools[3];
  assert.equal(swapPathFor(qwakk, QWAKK, slugs), "/swap/qwakk-qor");
  assert.equal(swapPathFor(qwakk, "uqor", slugs), "/swap/qor-qwakk");
  assert.equal(swapPath("6", slugs), "/swap/qwakk-qor");
});

test("indexed markets become candidates in the order the app shows them", () => {
  const market = { id: 6, token_a: "uqor", token_b: QWAKK, token_a_symbol: "QOR", token_b_symbol: "QWAKK", token_a_decimals: 6, token_b_decimals: 18, quote_side: "a" as const, tvl_quote: "123.5" };
  assert.deepEqual(marketPairCandidate(market), { id: "6", base: { denom: QWAKK, symbol: "QWAKK" }, quote: { denom: "uqor", symbol: "QOR" }, liquidity: 123.5 });
  assert.equal(poolPath(6, marketPairSlugs([market])), "/pools/qwakk-qor");
});
