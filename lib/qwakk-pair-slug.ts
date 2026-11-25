/**
 * Readable pair links: /pools/qwakk-qor and /swap/qwakk-qor instead of
 * /pools/6 and /swap?pool=6. A slug is the two token symbols, lowercased and
 * joined by "-". On a pool page the base token comes first, the order the app
 * shows pairs in. On the swap page the order is the direction: the first
 * token is paid, the second received. Only pools of two curated tokens get
 * a slug, spelled with the curated symbols. Numeric ids keep working
 * everywhere, so links already shared stay valid, and they are the exact way
 * to reach any other pool, or a second pool with the same pair. Pure, so the server, the browser and the
 * tests share it.
 */
import { assetForDenom } from "./qwakk-assets";
import { marketSides, type QuoteMarket } from "./qwakk-market-view";

export type PairToken = { denom: string; symbol: string };

/** One pool as the slug matcher reads it. */
export type PairCandidate = {
  id: string;
  base: PairToken;
  quote: PairToken;
  /** Pool value in its quote token (the indexer's `tvl_quote`), or null when unknown. */
  liquidity: number | null;
};

/** A route segment: a pool id, a two-symbol pair, or something that is neither. */
export type PairParam =
  | { kind: "id"; id: string }
  | { kind: "pair"; first: string; second: string }
  | { kind: "invalid" };

export type PairMatch = {
  pool: PairCandidate;
  /** "qwakk-qor", base first. Null when the pool has no usable symbols or another pool owns its pair. */
  poolSlug: string | null;
  /** The slug in the link's direction, paid token first. A numeric link pays with the base token. */
  swapSlug: string | null;
  /** The denom the link pays with. */
  payDenom: string;
};

/** Longer than any real symbol, short enough to keep a link readable. */
const PART = /^[a-z0-9]{1,32}$/;
/** Pool ids are uint64 on chain. */
const POOL_ID = /^\d{1,20}$/;

/** "fUSD" -> "fusd". Anything but letters and digits is dropped; empty when nothing usable is left. */
export function symbolSlug(symbol: string) {
  const value = String(symbol ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return PART.test(value) ? value : "";
}

/** "qwakk-qor", or null when either symbol has no usable slug or both are the same. */
export function pairSlug(first: string, second: string) {
  const a = symbolSlug(first);
  const b = symbolSlug(second);
  return a && b && a !== b ? `${a}-${b}` : null;
}

/** Reads a route segment. Case-insensitive; an unreadable escape is invalid. */
export function parsePairParam(raw: string): PairParam {
  let value: string;
  try {
    value = decodeURIComponent(String(raw ?? "")).trim().toLowerCase();
  } catch {
    return { kind: "invalid" };
  }
  if (POOL_ID.test(value)) {
    const id = value.replace(/^0+(?=\d)/, "");
    return id === "0" ? { kind: "invalid" } : { kind: "id", id };
  }
  const parts = value.split("-");
  if (parts.length === 2 && PART.test(parts[0]) && PART.test(parts[1]) && parts[0] !== parts[1]) {
    return { kind: "pair", first: parts[0], second: parts[1] };
  }
  return { kind: "invalid" };
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** An indexed market as a candidate, base and quote as the app shows them. */
export function marketPairCandidate(market: QuoteMarket & { id: string | number }): PairCandidate {
  const { base, quote } = marketSides(market);
  return {
    id: String(market.id),
    base: { denom: base.denom, symbol: base.symbol },
    quote: { denom: quote.denom, symbol: quote.symbol },
    liquidity: finite(market.tvl_quote),
  };
}

/**
 * Who may own a symbol in a link: the curated registry of the active network
 * (lib/qwakk-assets.ts). Only a pool whose two tokens are both curated gets a
 * slug, and with the curated symbols, so a look-alike token ("QWAKK." against
 * a fake "QOR") can never take over a readable link. Every other pool keeps
 * its id links.
 */
export type CuratedLookup = (denom: string) => { denom: string; symbol: string } | undefined;

/** The curated slug of each side, or null when either token is not curated. */
function curatedParts(candidate: PairCandidate, lookup: CuratedLookup) {
  const base = lookup(candidate.base.denom);
  const quote = lookup(candidate.quote.denom);
  // The exact chain denom, not a case variant of it.
  if (!base || !quote || base.denom !== candidate.base.denom || quote.denom !== candidate.quote.denom) return null;
  const a = symbolSlug(base.symbol);
  const b = symbolSlug(quote.symbol);
  return a && b && a !== b ? { base: a, quote: b } : null;
}

/** The same key for both orders of a pair. */
function pairKey(a: string, b: string) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function idNumber(id: string) {
  return BigInt(POOL_ID.test(id) ? id : "0");
}

/**
 * Two curated pools with one pair: the deeper pool wins, but liquidity is only
 * compared in the same quote token (it is counted in that token). Otherwise,
 * or on a tie, the older pool wins.
 */
function outranks(next: PairCandidate, current: PairCandidate) {
  if (next.quote.denom === current.quote.denom) {
    const a = next.liquidity ?? -1;
    const b = current.liquidity ?? -1;
    if (a !== b) return a > b;
  }
  return idNumber(next.id) < idNumber(current.id);
}

/** For every curated pair, the pool its slug opens. */
function pairOwners(candidates: readonly PairCandidate[], lookup: CuratedLookup) {
  const owners = new Map<string, PairCandidate>();
  for (const candidate of candidates) {
    const parts = curatedParts(candidate, lookup);
    if (!parts) continue;
    const key = pairKey(parts.base, parts.quote);
    const current = owners.get(key);
    if (!current || outranks(candidate, current)) owners.set(key, candidate);
  }
  return owners;
}

/**
 * Pool id to its base-first slug, for every pool that owns its pair. A pool
 * missing from the map is linked by its id.
 */
export function pairSlugsById(candidates: readonly PairCandidate[], lookup: CuratedLookup = assetForDenom) {
  const slugs = new Map<string, string>();
  for (const owner of pairOwners(candidates, lookup).values()) {
    const parts = curatedParts(owner, lookup);
    if (parts) slugs.set(owner.id, `${parts.base}-${parts.quote}`);
  }
  return slugs;
}

/** `pairSlugsById` for an indexed market list, the input every link in the app is made from. */
export function marketPairSlugs(markets: ReadonlyArray<QuoteMarket & { id: string | number }>, lookup: CuratedLookup = assetForDenom) {
  return pairSlugsById(markets.map(marketPairCandidate), lookup);
}

/** Pool page link: "/pools/qwakk-qor", or "/pools/7" when the pool has no slug of its own. */
export function poolPath(id: string | number, slugs: ReadonlyMap<string, string>) {
  const key = String(id);
  return `/pools/${slugs.get(key) ?? encodeURIComponent(key)}`;
}

/**
 * Swap link for a pool, paying with its base token: "/swap/qwakk-qor", or
 * "/swap?pool=7" when the pool has no slug of its own.
 */
export function swapPath(id: string | number, slugs: ReadonlyMap<string, string>) {
  const key = String(id);
  const slug = slugs.get(key);
  return slug ? `/swap/${slug}` : `/swap?pool=${encodeURIComponent(key)}`;
}

/** Swap link for a pool in a given direction (`payDenom` is paid). */
export function swapPathFor(candidate: PairCandidate, payDenom: string, slugs: ReadonlyMap<string, string>) {
  const slug = slugs.get(candidate.id);
  if (!slug) return `/swap?pool=${encodeURIComponent(candidate.id)}`;
  if (payDenom !== candidate.quote.denom) return `/swap/${slug}`;
  const [base, quote] = slug.split("-");
  return `/swap/${quote}-${base}`;
}

/**
 * Finds the pool a route segment names. A pair matches in either order and
 * opens the deepest pool with those symbols; an id opens exactly that pool.
 * Null when nothing matches.
 */
export function resolvePairParam(raw: string | PairParam, candidates: readonly PairCandidate[], lookup: CuratedLookup = assetForDenom): PairMatch | null {
  const param = typeof raw === "string" ? parsePairParam(raw) : raw;
  if (param.kind === "invalid") return null;
  const slugs = pairSlugsById(candidates, lookup);
  if (param.kind === "id") {
    const pool = candidates.find((candidate) => candidate.id === param.id);
    if (!pool) return null;
    const poolSlug = slugs.get(pool.id) ?? null;
    return { pool, poolSlug, swapSlug: poolSlug, payDenom: pool.base.denom };
  }
  const pool = pairOwners(candidates, lookup).get(pairKey(param.first, param.second));
  if (!pool) return null;
  const poolSlug = slugs.get(pool.id) ?? null;
  const baseFirst = poolSlug?.split("-")[0] === param.first;
  return {
    pool,
    poolSlug,
    swapSlug: poolSlug ? `${param.first}-${param.second}` : null,
    payDenom: baseFirst ? pool.base.denom : pool.quote.denom,
  };
}

/** The symbols a match shows, paid token first. */
export function matchSymbols(match: PairMatch) {
  const pay = match.payDenom === match.pool.quote.denom ? match.pool.quote : match.pool.base;
  const receive = pay === match.pool.base ? match.pool.quote : match.pool.base;
  return { base: match.pool.base.symbol, quote: match.pool.quote.symbol, pay: pay.symbol, receive: receive.symbol };
}
