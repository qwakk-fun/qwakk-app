import assert from "node:assert/strict";
import test from "node:test";

import { GET as getAssets } from "../app/api/native/assets/route";
import { clearAssetCache, readResolvedAssetCached } from "../lib/qwakk-asset-metadata";
import { formatTokenAmount, resolveUsableAsset } from "../lib/qwakk-asset-resolve";
import { assetFromBankMetadata, toBaseAmount } from "../lib/qwakk-assets";

const OSMO = "ibc/ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
const FETH = "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28";
/** Metadata that only lists the exponent 0 unit, the way Diana lists IBC ATOM. */
const UOSMO_ONLY = { base: OSMO, display: "transfer/channel-1/uosmo", symbol: "UOSMO", denom_units: [{ denom: "uosmo", exponent: 0 }] };

test("indexed decimals never become write decimals (uosmo-style metadata)", () => {
  // The indexer may store 6 for this token; the chain metadata does not say so.
  const hint = { symbol: "OSMO", decimals: 6 };
  const beforeRead = resolveUsableAsset(OSMO, undefined, hint);
  assert.equal(beforeRead.decimals, null);
  assert.equal(beforeRead.displayDecimals, 6);
  assert.equal(beforeRead.symbol, "OSMO");

  const fetched = assetFromBankMetadata(OSMO, UOSMO_ONLY);
  assert.equal(fetched.decimals, null);
  const afterRead = resolveUsableAsset(OSMO, fetched, hint);
  assert.equal(afterRead.decimals, null, "add liquidity, swap and create pool must stay blocked");
  assert.equal(afterRead.displayDecimals, 6);
});

test("write decimals come from the registry or from read metadata only", () => {
  assert.equal(resolveUsableAsset(FETH, undefined, { decimals: 0 }).decimals, 18);
  const metadata = { ...UOSMO_ONLY, denom_units: [...UOSMO_ONLY.denom_units, { denom: "osmo", exponent: 6 }] };
  const usable = resolveUsableAsset(OSMO, assetFromBankMetadata(OSMO, metadata), { decimals: 9 });
  assert.equal(usable.decimals, 6);
  assert.equal(toBaseAmount("2.5", usable.decimals as number), "2500000");
  assert.equal(resolveUsableAsset("ufoo", undefined).decimals, null);
});

test("unknown decimals show as labeled base units", () => {
  assert.equal(formatTokenAmount("9484", null, "OSMO"), "9484 OSMO base units");
  assert.equal(formatTokenAmount("1500000", 6, "fUSD"), "1.5 fUSD");
  assert.equal(formatTokenAmount("500000000000000000", 18, "fETH", 4), "0.5 fETH");
});

async function withFetch<T>(route: (url: string) => Response, run: (calls: string[]) => Promise<T>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return route(String(input));
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("the server caches successful metadata reads for a while, never failed ones", async () => {
  clearAssetCache();
  await withFetch((url) => url.includes("uoops") ? new Response("boom", { status: 500 }) : Response.json({ metadata: UOSMO_ONLY }), async (calls) => {
    const now = Date.now();
    assert.equal((await readResolvedAssetCached(OSMO, now))?.symbol, "UOSMO");
    await readResolvedAssetCached(OSMO, now + 1_000);
    assert.equal(calls.length, 1, "a cached read does not reach the node");
    await readResolvedAssetCached(OSMO, now + 6 * 60_000);
    assert.equal(calls.length, 2, "an expired entry is read again");
    assert.equal(await readResolvedAssetCached("uoops", now), null);
    assert.equal(await readResolvedAssetCached("uoops", now), null);
    assert.equal(calls.length, 4, "a failed read is not cached");
  });
  clearAssetCache();
});

test("the assets route is only cacheable when every denom was answered", async () => {
  clearAssetCache();
  await withFetch((url) => url.includes("uoops") ? new Response("boom", { status: 500 }) : Response.json({ code: 5, message: "client metadata for denom" }, { status: 404 }), async () => {
    const full = await getAssets(new Request(`http://local/api/native/assets?denom=uqor&denom=${encodeURIComponent(OSMO)}`));
    assert.equal(full.headers.get("Cache-Control"), "public, max-age=60");
    assert.equal(((await full.json()) as { assets: unknown[] }).assets.length, 2);

    const partial = await getAssets(new Request("http://local/api/native/assets?denom=uqor&denom=uoops"));
    assert.equal(partial.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(((await partial.json()) as { assets: Array<{ denom: string }> }).assets.map((asset) => asset.denom), ["uqor"]);

    const tooMany = await getAssets(new Request(`http://local/api/native/assets?${Array.from({ length: 21 }, (_, index) => `denom=utok${index}`).join("&")}`));
    assert.equal(tooMany.status, 400);
  });
  clearAssetCache();
});
