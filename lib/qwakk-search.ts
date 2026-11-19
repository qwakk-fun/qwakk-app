/**
 * Pool search, shared by the search dialog (components/SearchDialog.tsx), the
 * pools page and the swap page's pool picker, so one query finds the same
 * pools everywhere. Pure and import free, so tests run it directly.
 *
 * A query matches a token's symbol or name, a pool id ("6" or "#6"), or a
 * token's contract: a pasted `0x…` address in any case, the full
 * `erc20:0x…` denom or an `ibc/…` denom. Denoms keep their case on the chain,
 * but matching here ignores it.
 */

export type SearchToken = { denom: string; symbol: string; name?: string | null };

/** What the matcher reads from a pool. */
export type SearchEntry = { id: string; tokens: readonly SearchToken[] };

export type SearchQuery =
  | { kind: "empty" }
  /** A full 0x contract address, lower case. Also what `erc20:0x…` parses to. */
  | { kind: "address"; address: string }
  /** A full `ibc/…` denom, lower case. */
  | { kind: "denom"; denom: string }
  /** "6" or "#6". `terms` still match symbols and names, in case one holds the digits. */
  | { kind: "id"; id: string; terms: string[] }
  | { kind: "text"; terms: string[] };

export type SearchMatch<T> = {
  item: T;
  score: number;
  /** The token a full address or denom matched, so the caller can name it. */
  exactToken: SearchToken | null;
};

const ADDRESS = /^(?:erc20:)?(0x[0-9a-f]{40})$/i;
const IBC_DENOM = /^ibc\/[0-9a-f]{64}$/i;
const POOL_ID = /^#?(\d{1,12})$/;

/** Reads what the visitor typed or pasted. Quotes and spaces around a paste are dropped. */
export function parseSearchQuery(raw: string): SearchQuery {
  const value = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!value) return { kind: "empty" };
  const address = ADDRESS.exec(value);
  if (address) return { kind: "address", address: address[1].toLowerCase() };
  if (IBC_DENOM.test(value)) return { kind: "denom", denom: value.toLowerCase() };
  // A partial denom ("ibc/2739") stays one term; anything else splits on spaces and slashes ("QWAKK/QOR").
  const terms = /^(?:ibc\/|erc20:)/i.test(value) ? [value.toLowerCase()] : value.toLowerCase().split(/[\s/,]+/).filter(Boolean);
  const id = POOL_ID.exec(value);
  if (id) return { kind: "id", id: String(Number(id[1])), terms };
  return { kind: "text", terms };
}

/** True when the query is a full contract address or denom, so an empty result means the token is not listed. */
export function isTokenLookup(query: SearchQuery) {
  return query.kind === "address" || query.kind === "denom";
}

function words(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** How well one typed term fits one token. 0 is no match. */
function termScore(term: string, token: SearchToken) {
  const symbol = token.symbol.toLowerCase();
  const name = (token.name ?? "").toLowerCase();
  const denom = token.denom.toLowerCase();
  if (symbol === term) return 100;
  if (name === term) return 90;
  if (symbol.startsWith(term)) return 80;
  if (words(name).some((word) => word.startsWith(term))) return 60;
  // A partial address ("0xa5b3") or denom ("erc20:0xa5b3", "ibc/2739") from at least four characters.
  if (term.length >= 4 && (term.startsWith("0x") || term.startsWith("erc20:") || term.startsWith("ibc/")) && denom.includes(term)) return 50;
  if (symbol.includes(term)) return 40;
  if (name.includes(term)) return 30;
  return 0;
}

/** Address of an `erc20:0x…` denom, lower case, or null. */
function denomAddress(denom: string) {
  const match = ADDRESS.exec(denom);
  return match && denom.toLowerCase().startsWith("erc20:") ? match[1].toLowerCase() : null;
}

function scoreEntry(entry: SearchEntry, query: SearchQuery): { score: number; exactToken: SearchToken | null } {
  if (query.kind === "empty") return { score: 1, exactToken: null };
  if (query.kind === "address" || query.kind === "denom") {
    const token = entry.tokens.find((candidate) => query.kind === "address" ? denomAddress(candidate.denom) === query.address : candidate.denom.toLowerCase() === query.denom);
    return token ? { score: 1000, exactToken: token } : { score: 0, exactToken: null };
  }
  if (query.kind === "id" && entry.id === query.id) return { score: 1000, exactToken: null };
  // Every term has to land on some token; "qwakk qor" or "QWAKK/QOR" finds the pair.
  let total = 0;
  for (const term of query.terms) {
    const best = Math.max(0, ...entry.tokens.map((token) => termScore(term, token)));
    if (best === 0) return { score: 0, exactToken: null };
    total += best;
  }
  return { score: total, exactToken: null };
}

/**
 * The pools that match, best first. Equal scores keep the input order, so the
 * caller decides what wins a tie (the busiest pool, the selected one, …).
 * An empty query returns every item in input order.
 */
export function searchPools<T>(items: readonly T[], query: string | SearchQuery, toEntry: (item: T) => SearchEntry, limit = Infinity): SearchMatch<T>[] {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  const matches: Array<SearchMatch<T> & { index: number }> = [];
  items.forEach((item, index) => {
    const { score, exactToken } = scoreEntry(toEntry(item), parsed);
    if (score > 0) matches.push({ item, score, exactToken, index });
  });
  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  return matches.slice(0, limit).map(({ item, score, exactToken }) => ({ item, score, exactToken }));
}

/** The one token a pasted address or denom names, or null when it names none (or, oddly, several). */
export function matchedToken<T>(matches: readonly SearchMatch<T>[]): SearchToken | null {
  const denoms = new Map<string, SearchToken>();
  for (const match of matches) if (match.exactToken) denoms.set(match.exactToken.denom.toLowerCase(), match.exactToken);
  return denoms.size === 1 ? [...denoms.values()][0] : null;
}

/** `0xa5b3…eE23`, so a pasted address fits on one line. */
export function shortQuery(raw: string, max = 24) {
  const value = raw.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.ceil((max - 1) / 2))}…${value.slice(-Math.floor((max - 1) / 2))}`;
}

/**
 * What to say when nothing matches. A full address or denom says plainly that
 * the token has no pool here, without suggesting anyone can add one.
 */
export function searchEmptyCopy(raw: string, brandName: string): { title: string; body: string } {
  const query = parseSearchQuery(raw);
  if (isTokenLookup(query)) {
    return {
      title: `Not listed on ${brandName} yet`,
      body: `No pool on ${brandName} trades this token. Double-check the address, or search by name.`,
    };
  }
  return {
    title: `No pools match “${shortQuery(raw)}”`,
    body: "Try a symbol such as QOR, a pool number, or paste a token address.",
  };
}

/** The swap page listens for this, so a search result can switch its pool without reloading. */
export const SELECT_POOL_EVENT = "qwakk:select-pool";
