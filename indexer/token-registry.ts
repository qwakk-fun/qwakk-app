/**
 * Token facts the indexer trusts over chain metadata, and the rules that turn
 * a bank denom metadata record into a stored token row.
 *
 * The indexer ships alone (the production image copies only indexer/ and
 * dist/), so it cannot import lib/qwakk-assets.ts. Keep this list in step with
 * the app's asset registry when a token is added there.
 */

import { networkIdFromEnv, type IndexerNetworkId } from "./indexer-config";

export type CuratedToken = {
  symbol: string;
  name: string;
  decimals: number;
  /** Lower ranks are preferred as the quote side of a pair (QOR first, then stable-like tokens). */
  quoteRank?: number;
  /** Pools quoted in this token below this TVL, in display units, are flagged as low liquidity. */
  minTvl?: string;
};

/**
 * QWAKK on Diana: the same value as QWAKK_TOKEN_ADDRESS in lib/qwakk-assets.ts
 * (null until the token is deployed, registered and pooled; a test checks they
 * match). Chain metadata alone already resolves it (symbol QWAKK, display
 * "Qwakk", 6 decimals); the entry pins those values like the other tokens.
 */
export const QWAKK_TOKEN_ADDRESS: string | null = "0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23";

function qwakkEntry(address: string | null): Record<string, CuratedToken> {
  return address ? { [`erc20:${address.toLowerCase()}`]: { symbol: "QWAKK", name: "Qwakk", decimals: 6 } } : {};
}

/**
 * QCAT (Quantum Cat) on Diana: the same value as QCAT_TOKEN_ADDRESS in
 * lib/qwakk-assets.ts (null until registered and pooled; a test checks they
 * match). Deployed at 0x36a4D630898e22dedD8eF5978FC8C527D1698456.
 */
export const QCAT_TOKEN_ADDRESS: string | null = "0x36a4D630898e22dedD8eF5978FC8C527D1698456";

function qcatEntry(address: string | null): Record<string, CuratedToken> {
  return address ? { [`erc20:${address.toLowerCase()}`]: { symbol: "QCAT", name: "Quantum Cat", decimals: 6 } } : {};
}

/** Keys are lowercase: erc20 hex addresses and IBC hashes are matched case-insensitively. */
const CURATED_TOKENS: Readonly<Record<IndexerNetworkId, Record<string, CuratedToken>>> = {
  testnet: {
    uqor: { symbol: "QOR", name: "QoreChain", decimals: 6, quoteRank: 0, minTvl: "10" },
    "erc20:0x97143b771d34ddb9130b807b135ae675a5a963ca": { symbol: "fUSD", name: "FestUSD", decimals: 6, quoteRank: 1, minTvl: "10" },
    "erc20:0x02292293c13880a26242690eb70a0e42b8e91c28": { symbol: "fETH", name: "FestETH", decimals: 18 },
    "erc20:0x4604e7e45b2ecdbfbdc157103f5b2b62cb16451a": { symbol: "fBTC", name: "FestBTC", decimals: 8 },
    // Chain metadata only lists the uatom unit (exponent 0, symbol UATOM).
    "ibc/27394fb092d2eccd56123c74f36e4c1f926001ceada9ca97ea622b25f41e5eb2": { symbol: "ATOM", name: "Cosmos Hub ATOM", decimals: 6 },
    ...qwakkEntry(QWAKK_TOKEN_ADDRESS),
    ...qcatEntry(QCAT_TOKEN_ADDRESS),
  },
  // Mainnet bank supply holds only uqor (checked 2026-10-31). Add tokens here as they launch.
  mainnet: {
    uqor: { symbol: "QOR", name: "QoreChain", decimals: 6, quoteRank: 0, minTvl: "10" },
  },
};

/** The network this process indexes, read once from QWAKK_NETWORK. */
const ACTIVE_NETWORK: IndexerNetworkId = networkIdFromEnv(typeof process !== "undefined" ? process.env : {}).id;

export function curatedToken(denom: string, network: IndexerNetworkId = ACTIVE_NETWORK): CuratedToken | undefined {
  return CURATED_TOKENS[network][denom.toLowerCase()];
}

export function quoteRank(denom: string, network: IndexerNetworkId = ACTIVE_NETWORK) {
  return curatedToken(denom, network)?.quoteRank ?? null;
}

export function minTvlFor(denom: string, network: IndexerNetworkId = ACTIVE_NETWORK) {
  return curatedToken(denom, network)?.minTvl ?? null;
}

export type DenomMetadata = {
  symbol?: string;
  name?: string;
  display?: string;
  base?: string;
  uri?: string;
  denom_units?: Array<{ denom?: string; exponent?: number }>;
};

export type TokenInfo = {
  symbol: string;
  name: string | null;
  /** Null when nothing trustworthy says how many decimals the token has. */
  decimals: number | null;
  imageUrl: string | null;
  source: "curated" | "chain" | "fallback";
};

function shorten(value: string, head: number, tail: number) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}\u2026${value.slice(-tail)}` : value;
}

/** A readable symbol for a denom nobody described. Same format as displaySymbol in lib/qwakk-assets.ts. */
export function fallbackSymbol(denom: string, network: IndexerNetworkId = ACTIVE_NETWORK) {
  const curated = curatedToken(denom, network);
  if (curated) return curated.symbol;
  const erc20 = /^erc20:(0x[0-9a-fA-F]{40})$/.exec(denom);
  if (erc20) return shorten(erc20[1], 6, 4);
  const ibc = /^ibc\/([0-9A-Fa-f]{64})$/.exec(denom);
  if (ibc) return `IBC ${shorten(ibc[1].toUpperCase(), 4, 4)}`;
  if (/^[a-z][a-z0-9]{1,15}$/.test(denom)) return denom.replace(/^u(?=[a-z])/, "").toUpperCase();
  const last = denom.split("/").pop() ?? denom;
  return shorten(last || denom, 8, 4);
}

/**
 * Curated facts win, then chain metadata, then a fallback. Decimals come only
 * from a curated entry or a metadata unit with a positive exponent. Metadata
 * that lists only the exponent 0 base unit (as Diana's ATOM entry does) says
 * nothing about display decimals, so the decimals stay unknown (null) rather
 * than guessed; market math treats such pools as unpriced.
 */
export function resolveTokenInfo(denom: string, metadata: DenomMetadata | undefined, network: IndexerNetworkId = ACTIVE_NETWORK): TokenInfo {
  const imageUrl = metadata?.uri || null;
  const curated = curatedToken(denom, network);
  if (curated) return { symbol: curated.symbol, name: curated.name, decimals: curated.decimals, imageUrl, source: "curated" };

  if (metadata) {
    const exponents = (metadata.denom_units ?? []).map((unit) => Number(unit.exponent ?? 0)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 36);
    const highest = exponents.length ? Math.max(...exponents) : 0;
    // erc20 metadata repeats the denom as its name; the display unit reads better.
    const name = metadata.name && metadata.name !== denom ? metadata.name : metadata.display && metadata.display !== denom ? metadata.display : null;
    return { symbol: metadata.symbol || fallbackSymbol(denom, network), name, decimals: highest > 0 ? highest : null, imageUrl, source: "chain" };
  }

  return { symbol: fallbackSymbol(denom, network), name: null, decimals: null, imageUrl: null, source: "fallback" };
}
