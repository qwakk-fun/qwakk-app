/**
 * Pools page list logic: which tab is open, how the pools are ordered and
 * filtered, which low-liquidity pools fold away, and the short numbers each
 * row shows (components/MarketsView.tsx, components/PoolsList.tsx). Pure, so
 * tests call it directly.
 */
import { formatQuotePrice, isLowLiquidity, marketChange, marketSearchEntry, type QuoteMarket } from "./qwakk-market-view";
import { searchPools } from "./qwakk-search";

type Num = string | number | null | undefined;

/** What the list reads from a pool. The hook's `Market` fits it. */
export type ListMarket = QuoteMarket & { id: string | number; transactions_24h?: Num };

export type PoolsSort = "trending" | "newest" | "moves";
export type PoolsTab = PoolsSort | "favorites";

export const POOLS_TABS: readonly { id: PoolsTab; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "newest", label: "Newest" },
  { id: "moves", label: "Biggest moves" },
  { id: "favorites", label: "Favorites" },
];

const TAB_IDS = new Set<string>(POOLS_TABS.map((tab) => tab.id));

/**
 * The tab the page opens on. `?view=favorites` wins; otherwise the tab this
 * browser last chose. Older visits stored "all" (the list in its default
 * order) or "favorites" under the same key, so both still read correctly.
 */
export function initialPoolsTab(viewParam: string | null, stored: string | null): PoolsTab {
  if (viewParam === "favorites") return "favorites";
  return stored && TAB_IDS.has(stored) ? stored as PoolsTab : "trending";
}

function count(value: Num) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Trending: most swaps in 24h. Newest: highest pool id. Biggest moves: the
 * largest 24h change either way, pools without one last. Ties keep pool id order.
 */
export function sortPools<T extends ListMarket>(markets: readonly T[], sort: PoolsSort): T[] {
  const byId = (a: T, b: T) => count(b.id) - count(a.id);
  const sorted = [...markets];
  if (sort === "newest") return sorted.sort(byId);
  if (sort === "trending") return sorted.sort((a, b) => count(b.transactions_24h) - count(a.transactions_24h) || byId(a, b));
  return sorted.sort((a, b) => Math.abs(marketChange(b) ?? -1) - Math.abs(marketChange(a) ?? -1) || byId(a, b));
}

/**
 * The list for a sort tab: pools matching `query` (lib/qwakk-search.ts) in the
 * chosen order, with low-liquidity pools split off so they fold away at the end.
 */
export function poolsList<T extends ListMarket>(markets: readonly T[], query: string, sort: PoolsSort) {
  const matched = query.trim() ? searchPools(markets, query, marketSearchEntry).map((match) => match.item) : markets;
  const ordered = sortPools(matched, sort);
  return { listed: ordered.filter((market) => !isLowLiquidity(market)), low: ordered.filter(isLowLiquidity) };
}

/**
 * Starred pool ids in starred order (newest first), narrowed by `query`. A
 * starred pool the indexer no longer lists stays only while nothing is typed,
 * since there is nothing left to match it against.
 */
export function favoritePoolIds<T extends ListMarket>(ids: readonly string[], markets: readonly T[], query: string) {
  if (!query.trim()) return [...ids];
  const matched = new Set(searchPools(markets, query, marketSearchEntry).map((match) => String(match.item.id)));
  return ids.filter((id) => matched.has(id));
}

/** Open pools and their swaps in the last 24h, for the line under the title. */
export function poolsSummary(markets: readonly ListMarket[]) {
  return { pools: markets.length, swaps24h: markets.reduce((total, market) => total + count(market.transactions_24h), 0) };
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const small = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** A volume or pool value at a glance: "555.34K", "10.77M", "1,554.86", "0.245". Null when unknown. */
export function formatCompactAmount(value: Num): string | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number >= 10_000) return compact.format(number);
  if (number >= 1) return plain.format(number);
  return number === 0 ? "0" : small.format(number);
}

const bigPrice = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 });

/**
 * A price for a list row. From a million up it turns compact ("1.115T"), so a
 * token with many decimals still fits its column; the pool page shows it in full.
 */
export function formatListPrice(value: number) {
  return Number.isFinite(value) && Math.abs(value) >= 1_000_000 ? bigPrice.format(value) : formatQuotePrice(value);
}

/**
 * A 24h change as the list shows it: the arrow and color carry the direction
 * for sighted visitors, `word` says it to screen readers. Null when unknown.
 */
export function changeBadge(change: number | null) {
  if (change === null || !Number.isFinite(change)) return null;
  const rounded = Math.round(Math.abs(change) * 100) / 100;
  const tone = rounded === 0 ? "flat" : change > 0 ? "up" : "down";
  return {
    tone,
    arrow: tone === "up" ? "▲" : tone === "down" ? "▼" : "",
    word: tone === "up" ? "up" : tone === "down" ? "down" : "",
    text: `${plain.format(rounded)}%`,
  } as const;
}
