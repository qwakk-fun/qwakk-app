import { QORECHAIN_REST_URL } from "@/lib/qorechain-endpoints";
import { assetForDenom, assetFromBankMetadata, unknownAsset, type BankDenomMetadata, type ResolvedAsset } from "@/lib/qwakk-assets";

/** Same denom shape the AMM routes accept: `uqor`, `erc20:0x…`, `ibc/…`, `factory/…`. */
export const ASSET_DENOM = /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/;

/** Successful reads are kept briefly so this public route cannot fan out to the node per request. */
export const ASSET_CACHE_TTL_MS = 5 * 60_000;
const ASSET_CACHE_MAX = 500;
const assetCache = new Map<string, { asset: ResolvedAsset; expiresAt: number }>();

/** Test hook: forget every cached read. */
export function clearAssetCache() {
  assetCache.clear();
}

/**
 * `readResolvedAsset` behind an in-memory TTL cache. Only successful reads
 * (including "no metadata") are cached; a failed read is retried next time.
 */
export async function readResolvedAssetCached(denom: string, now = Date.now()): Promise<ResolvedAsset | null> {
  const cached = assetCache.get(denom);
  if (cached && cached.expiresAt > now) return cached.asset;
  if (cached) assetCache.delete(denom);
  const asset = await readResolvedAsset(denom);
  if (asset && asset.source !== "curated") {
    // Oldest entry first out once the cap is reached (Map keeps insertion order).
    if (assetCache.size >= ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value as string);
    assetCache.set(denom, { asset, expiresAt: now + ASSET_CACHE_TTL_MS });
  }
  return asset;
}

/**
 * Resolves one denom for display and amount entry. Curated tokens never touch
 * the network. Others are read from bank metadata
 * (`GET /cosmos/bank/v1beta1/denoms_metadata/{denom}`, URL-encoded so `ibc/…`
 * and `erc20:…` keep their exact case; both answer 200 on Diana, checked
 * 2026-10-31). A denom without metadata (Diana answers 404, code 5) resolves
 * with unknown decimals. Returns null when the chain could not be read, so a
 * transient failure is never remembered as "unknown".
 */
export async function readResolvedAsset(denom: string): Promise<ResolvedAsset | null> {
  const curated = assetForDenom(denom);
  if (curated) return { ...curated, source: "curated" };
  if (!ASSET_DENOM.test(denom)) return null;
  try {
    const response = await fetch(`${QORECHAIN_REST_URL}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return unknownAsset(denom);
    if (!response.ok) return null;
    const body = await response.json() as { metadata?: BankDenomMetadata };
    const metadata = body?.metadata;
    // Metadata for another base denom is not this token's metadata.
    if (!metadata || typeof metadata !== "object" || (typeof metadata.base === "string" && metadata.base !== denom)) return unknownAsset(denom);
    return assetFromBankMetadata(denom, metadata);
  } catch {
    return null;
  }
}
