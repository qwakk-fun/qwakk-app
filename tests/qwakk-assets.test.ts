import assert from "node:assert/strict";
import test from "node:test";

import { qorechainRegistry } from "@qorechain/sdk";

import { curatedToken } from "../indexer/token-registry";
import { readResolvedAsset } from "../lib/qwakk-asset-metadata";
import {
  DIANA_ASSETS,
  assetForDenom,
  assetFromBankMetadata,
  createPoolTokenOptions,
  decimalsFromBankMetadata,
  displaySymbol,
  formatBaseAmount,
  resolveAsset,
  toBaseAmount,
  withAssetOverrides,
} from "../lib/qwakk-assets";
import { encodedMessagesForAction, parseNativeAction } from "../lib/qwakk-native-actions";
import { encodeAsAny } from "../lib/qwakk-native-tx";
import { buildCreatePoolPlan } from "../lib/qwakk-pool-route";

const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
const FBTC = "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const sender = "qor1exampleaddress000000000000";
const registry = qorechainRegistry();

test("curated Diana tokens carry the chain's exact denoms and decimals", () => {
  assert.deepEqual(DIANA_ASSETS.map((asset) => [asset.symbol, asset.denom, asset.decimals]), [
    ["QOR", "uqor", 6],
    ["fUSD", FUSD, 6],
    ["fETH", FETH, 18],
    ["fBTC", FBTC, 8],
    ["ATOM", ATOM, 6],
  ]);
  assert.equal(assetForDenom("uusdc"), undefined);
});

test("lookups ignore case but always hand back the exact chain denom", () => {
  assert.equal(assetForDenom(FETH.toLowerCase())?.denom, FETH);
  assert.equal(assetForDenom(ATOM.toLowerCase())?.denom, ATOM);
  assert.deepEqual(assetForDenom(ATOM), { denom: ATOM, symbol: "ATOM", name: "Cosmos Hub ATOM", decimals: 6, icon: "atom" });
});

test("entered amounts convert to base units with BigInt math for 6, 8 and 18 decimals", () => {
  assert.equal(toBaseAmount("100", assetForDenom(FUSD)!.decimals), "100000000");
  assert.equal(toBaseAmount("0.5", assetForDenom(FETH)!.decimals), "500000000000000000");
  assert.equal(toBaseAmount("0.02", assetForDenom(FBTC)!.decimals), "2000000");
  assert.equal(toBaseAmount("1.5", assetForDenom(ATOM)!.decimals), "1500000");
  assert.equal(toBaseAmount("123456789.123456789123456789", 18), "123456789123456789123456789");
  assert.throws(() => toBaseAmount("0.000000001", 8), /up to 8 decimal places/);
  assert.throws(() => toBaseAmount("1", 19), /decimal setting/);
});

test("base amounts format exactly, cutting extra digits instead of rounding", () => {
  assert.equal(formatBaseAmount("500000000000000000", 18, 6), "0.5");
  assert.equal(formatBaseAmount("980129", 18, 6), "0");
  assert.equal(formatBaseAmount("980129", 18, 18), "0.000000000000980129");
  assert.equal(formatBaseAmount("123456789123456789123456789", 18, 18), "123456789.123456789123456789");
  assert.equal(formatBaseAmount("1500010", 6, 4), "1.5");
  assert.equal(formatBaseAmount("2000000", 8, 8), "0.02");
  assert.equal(formatBaseAmount(toBaseAmount("0.5", 18), 18, 18), "0.5");
});

test("symbols never show a raw erc20 or ibc string", () => {
  assert.equal(displaySymbol(FUSD), "fUSD");
  assert.equal(displaySymbol(ATOM), "ATOM");
  assert.equal(displaySymbol("erc20:0x1111111111111111111111111111111111111111"), "0x1111…1111");
  assert.equal(displaySymbol("ibc/ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"), "IBC ABCD…6789");
  assert.equal(displaySymbol("utest"), "TEST");
  assert.equal(displaySymbol("factory/qor1creator/duckcoin"), "duckcoin");
});

test("bank metadata gives decimals only from a real display unit", () => {
  const festUsd = { base: FUSD, display: "FestUSD", symbol: "fUSD", name: FUSD, denom_units: [{ denom: FUSD, exponent: 0 }, { denom: "FestUSD", exponent: 6 }] };
  assert.equal(decimalsFromBankMetadata(festUsd), 6);
  // Diana's ATOM metadata lists only the exponent 0 unit: unknown, not 0.
  const uatom = { base: ATOM, display: "transfer/channel-0/uatom", symbol: "UATOM", denom_units: [{ denom: "uatom", exponent: 0 }] };
  assert.equal(decimalsFromBankMetadata(uatom), null);
  assert.equal(decimalsFromBankMetadata({ denom_units: [{ exponent: 24 }] }), null);
  assert.equal(decimalsFromBankMetadata(undefined), null);

  const other = "erc20:0x2222222222222222222222222222222222222222";
  assert.deepEqual(assetFromBankMetadata(other, { ...festUsd, base: other, name: other, symbol: "fXYZ" }), { denom: other, symbol: "fXYZ", name: "fXYZ", decimals: 6, icon: "generic", source: "chain" });
  // Curated values win over incomplete metadata.
  assert.equal(assetFromBankMetadata(ATOM, uatom).decimals, 6);
  assert.equal(assetFromBankMetadata(ATOM, uatom).symbol, "ATOM");
  assert.equal(assetFromBankMetadata("ufoo", null).decimals, null);
});

test("an indexed decimals hint of 0 is treated as unknown", () => {
  assert.equal(resolveAsset("ufoo", { symbol: "FOO", decimals: 0 }).decimals, null);
  assert.equal(resolveAsset("ufoo", { symbol: "FOO", decimals: "8" }).decimals, 8);
  assert.equal(resolveAsset(ATOM, { symbol: "UATOM", decimals: 0 }).decimals, 6);
});

test("indexed rows take curated symbols and decimals", () => {
  const row = { token_a: ATOM, token_b: "uqor", token_a_symbol: "UATOM", token_b_symbol: "QOR", token_a_name: "transfer/channel-0/uatom IBC token", token_b_name: null, token_a_decimals: 0, token_b_decimals: 6, reserve_a: "1" };
  assert.deepEqual(withAssetOverrides(row), { ...row, token_a_symbol: "ATOM", token_a_decimals: 6, token_a_name: "Cosmos Hub ATOM", token_b_name: "QoreChain" });
  const unknown = { token_a: "ufoo", token_b: "ubar", token_a_symbol: "FOO", token_b_symbol: "BAR" };
  assert.equal(withAssetOverrides(unknown), unknown);
});

test("create pool offers every curated token plus held denoms, case preserved", () => {
  const balances = new Map([["uqor", BigInt(5)], [FETH, BigInt(1)], ["factory/qor1x/Duck", BigInt(3)], ["uempty", BigInt(0)]]);
  assert.deepEqual(createPoolTokenOptions(balances), ["uqor", FUSD, FETH, FBTC, ATOM, "factory/qor1x/Duck"]);
  assert.deepEqual(createPoolTokenOptions(null), DIANA_ASSETS.map((asset) => asset.denom));
});

test("100 fUSD against 100 QOR builds MsgCreatePool with the exact denom and amounts", () => {
  const amountA = toBaseAmount("100", assetForDenom("uqor")!.decimals);
  const amountB = toBaseAmount("100", assetForDenom(FUSD)!.decimals);
  const plan = buildCreatePoolPlan({ creator: sender, poolType: "constant_product", denomA: "uqor", amountA, denomB: FUSD, amountB });
  const decoded = registry.decode(encodeAsAny([plan.message])[0]) as { initialDepositA: { denom: string; amount: string }; initialDepositB: { denom: string; amount: string } };
  // Byte order: "erc20:…" sorts before "uqor".
  assert.deepEqual({ denom: decoded.initialDepositA.denom, amount: decoded.initialDepositA.amount }, { denom: FUSD, amount: "100000000" });
  assert.deepEqual({ denom: decoded.initialDepositB.denom, amount: decoded.initialDepositB.amount }, { denom: "uqor", amount: "100000000" });
});

test("a fETH swap keeps the checksum-case denom through the action parser", () => {
  const action = parseNativeAction({ kind: "swap", poolId: "1", denomIn: FETH, amountIn: toBaseAmount("0.5", 18), denomOut: "uqor", minOut: "1" });
  const [message] = encodedMessagesForAction(sender, action, { enabled: false, feeBps: 0 });
  const decoded = registry.decode(message) as { tokenIn: { denom: string; amount: string }; denomOut: string };
  assert.deepEqual({ denom: decoded.tokenIn.denom, amount: decoded.tokenIn.amount, denomOut: decoded.denomOut }, { denom: FETH, amount: "500000000000000000", denomOut: "uqor" });
});

test("server asset reads use bank metadata for unknown denoms and never cache a failed read as unknown", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  const other = "ibc/ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith(encodeURIComponent(other))) return Response.json({ metadata: { base: other, symbol: "OSMO", display: "osmo", denom_units: [{ denom: "uosmo", exponent: 0 }, { denom: "osmo", exponent: 6 }] } });
    if (url.endsWith("/uoops")) return new Response("boom", { status: 500 });
    return Response.json({ code: 5, message: "client metadata for denom" }, { status: 404 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await readResolvedAsset(FBTC), { ...assetForDenom(FBTC), source: "curated" });
    assert.equal(seen.length, 0);
    const osmo = await readResolvedAsset(other);
    assert.equal(osmo?.symbol, "OSMO");
    assert.equal(osmo?.decimals, 6);
    assert.ok(seen[0].endsWith(`/cosmos/bank/v1beta1/denoms_metadata/ibc%2FABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789`));
    assert.equal((await readResolvedAsset("unone"))?.decimals, null);
    assert.equal(await readResolvedAsset("uoops"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("the indexer's curated tokens match the app registry", () => {
  for (const asset of DIANA_ASSETS) {
    const indexed = curatedToken(asset.denom);
    assert.ok(indexed, `${asset.symbol} is missing from indexer/token-registry.ts`);
    assert.deepEqual({ symbol: indexed.symbol, name: indexed.name, decimals: indexed.decimals }, { symbol: asset.symbol, name: asset.name, decimals: asset.decimals });
  }
});
