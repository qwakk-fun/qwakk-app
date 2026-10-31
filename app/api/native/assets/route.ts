import { ASSET_DENOM, readResolvedAssetCached } from "@/lib/qwakk-asset-metadata";

const MAX_DENOMS = 20;

/**
 * Token details (symbol, name, decimals, icon) for up to 20 denoms:
 * `?denom=<exact denom>&denom=…`. Curated tokens answer from Qwakk's registry;
 * other denoms from QoreChain Diana's bank metadata. A denom whose details
 * could not be read is left out, so the browser asks again later. Read only.
 */
export async function GET(request: Request) {
  const denoms = [...new Set(new URL(request.url).searchParams.getAll("denom").map((value) => value.trim()))];
  if (!denoms.length || denoms.length > MAX_DENOMS || !denoms.every((denom) => ASSET_DENOM.test(denom))) {
    return Response.json({ error: "Up to 20 valid token denoms are required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const resolved = await Promise.all(denoms.map((denom) => readResolvedAssetCached(denom)));
  const assets = resolved.filter((asset) => asset !== null);
  // A partial answer must not be cached by the browser or a proxy: the missing denoms are asked for again.
  const complete = assets.length === denoms.length;
  return Response.json(
    { assets },
    { headers: { "Cache-Control": complete ? "public, max-age=60" : "no-store" } },
  );
}
