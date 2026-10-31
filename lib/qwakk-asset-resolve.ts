import { assetForDenom, formatVisibleAmount, resolveAsset, type ResolvedAsset } from "./qwakk-assets";

/** Token details from indexed data (the indexer's token row). Display only. */
export type AssetHint = { symbol?: unknown; name?: unknown; decimals?: unknown };

/**
 * A token as a form can use it. `decimals` is write-safe: it comes only from
 * the curated registry or from bank metadata read through
 * `/api/native/assets`, and is null otherwise, so amount entry blocks.
 * `displayDecimals` may also fall back to indexed data and is for showing
 * amounts only, never for turning typed amounts into base units.
 */
export type UsableAsset = ResolvedAsset & { displayDecimals: number | null };

/**
 * Combines the three sources in a fixed order. Indexed decimals never reach
 * `decimals`: the indexer can store a default for a token whose metadata only
 * lists an exponent 0 unit (an `ibc/…` with just `uosmo`), which the app treats
 * as unknown.
 */
export function resolveUsableAsset(denom: string, fetched: ResolvedAsset | undefined, hint?: AssetHint): UsableAsset {
  const curated = assetForDenom(denom);
  if (curated) return { ...curated, source: "curated", displayDecimals: curated.decimals };
  const labels = resolveAsset(denom, hint ? { symbol: hint.symbol, name: hint.name } : undefined);
  const indexedDecimals = hint ? resolveAsset(denom, hint).decimals : null;
  if (fetched?.source === "chain") return { ...fetched, displayDecimals: fetched.decimals ?? indexedDecimals };
  return { ...labels, decimals: null, source: "unknown", displayDecimals: indexedDecimals };
}

/**
 * An amount with its symbol for display. When the decimals are unknown, the
 * raw integer is labeled as base units instead of being shown at a guessed scale.
 * A non-zero amount never reads as 0 (see `formatVisibleAmount`).
 */
export function formatTokenAmount(amount: string, decimals: number | null, symbol: string, maximumFractionDigits = 6) {
  if (decimals === null) return `${amount} ${symbol} base units`;
  return `${formatVisibleAmount(amount, decimals, maximumFractionDigits)} ${symbol}`;
}
