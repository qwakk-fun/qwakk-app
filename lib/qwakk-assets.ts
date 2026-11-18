/**
 * Qwakk's asset registry. Kept free of imports so the browser, the server
 * routes and the indexer can all share it.
 *
 * Denoms are case sensitive on QoreChain (`erc20:0x…` keeps its checksum case,
 * `ibc/…` its upper-case hash): Diana's `pool_by_denoms` finds pool 1 for
 * `erc20:0x02292293c13880a26242690eb70a0e42B8E91c28` and answers "no pool" for
 * the same address in lower case (checked 2026-10-31). Lookups here ignore
 * case, but every value sent to the chain must be the exact denom the chain
 * reported (a balance, a pool, or `QwakkAsset.denom`).
 */

export type QwakkAssetIcon = "qor" | "usd" | "eth" | "btc" | "atom" | "qwakk" | "generic";

export type QwakkAsset = {
  /** The exact on-chain denom, case preserved. */
  denom: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: QwakkAssetIcon;
};

/**
 * An asset as Qwakk can describe it right now. `decimals` is null when nothing
 * trustworthy says how many decimals the token uses: amounts can then only be
 * shown, never entered, and every write path must block on it.
 */
export type ResolvedAsset = Omit<QwakkAsset, "decimals"> & {
  decimals: number | null;
  source: "curated" | "chain" | "unknown";
};

/**
 * QWAKK, Qwakk's own token on QoreChain Diana: the EIP-55 address of the
 * QwakkToken contract (contracts/src/QwakkToken.sol), or null.
 *
 * Keep it null until all three hold on Diana: the contract is deployed,
 * QoreChain has registered it as a token pair (bank denom `erc20:<address>`),
 * and the QWAKK/QOR pool exists. `npm run token -- status` in contracts/cli
 * shows all three. While it is null the registry has no QWAKK entry, so
 * nothing in the app offers or names QWAKK ahead of the chain. Set the same
 * address in indexer/token-registry.ts; tests/qwakk-assets.test.ts checks that
 * both match and that the spelling is EIP-55 (the denom is case sensitive).
 */
export const QWAKK_TOKEN_ADDRESS: string | null = null;

/**
 * The curated QWAKK entry for a token address. The values are the contract's
 * own: name() "Qwakk", symbol() "QWAKK", decimals() 6, which registration
 * copies into the bank metadata (symbol QWAKK, display unit "Qwakk" at
 * exponent 6). Being Qwakk's own token, its official icon is the duck mark.
 */
export function qwakkTokenAsset(address: string | null): QwakkAsset | null {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return { denom: `erc20:${address}`, symbol: "QWAKK", name: "Qwakk", decimals: 6, icon: "qwakk" };
}

const DIANA_QWAKK = qwakkTokenAsset(QWAKK_TOKEN_ADDRESS);

/**
 * Curated tokens on QoreChain Diana. Values match Diana's
 * `/cosmos/bank/v1beta1/denoms_metadata` (checked 2026-10-31), except ATOM:
 * its IBC metadata (transfer/channel-0/uatom from the Cosmos Hub testnet) only
 * lists the exponent 0 unit "uatom" and the symbol "UATOM", while uatom is the
 * micro unit of ATOM, so Qwakk shows it as ATOM with 6 decimals. QWAKK joins
 * only once `QWAKK_TOKEN_ADDRESS` is set.
 */
export const DIANA_ASSETS: readonly QwakkAsset[] = [
  { denom: "uqor", symbol: "QOR", name: "QoreChain", decimals: 6, icon: "qor" },
  { denom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA", symbol: "fUSD", name: "FestUSD", decimals: 6, icon: "usd" },
  { denom: "erc20:0x02292293c13880a26242690eb70a0e42B8E91c28", symbol: "fETH", name: "FestETH", decimals: 18, icon: "eth" },
  { denom: "erc20:0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A", symbol: "fBTC", name: "FestBTC", decimals: 8, icon: "btc" },
  { denom: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", symbol: "ATOM", name: "Cosmos Hub ATOM", decimals: 6, icon: "atom" },
  ...(DIANA_QWAKK ? [DIANA_QWAKK] : []),
];

/**
 * Curated tokens on QoreChain mainnet (`qorechain-vladi`). Its bank supply
 * holds only `uqor` (`https://api.qore.host/cosmos/bank/v1beta1/supply`,
 * checked 2026-10-31; docs.qorechain.io/appendix/networks: "Test tokens: None").
 */
export const MAINNET_ASSETS: readonly QwakkAsset[] = [
  { denom: "uqor", symbol: "QOR", name: "QoreChain", decimals: 6, icon: "qor" },
];

/** Keys match `QwakkNetworkId` in lib/qwakk-network.ts (kept import free on purpose). */
export type AssetNetworkId = "testnet" | "mainnet";

export const ASSETS_BY_NETWORK: Readonly<Record<AssetNetworkId, readonly QwakkAsset[]>> = {
  testnet: DIANA_ASSETS,
  mainnet: MAINNET_ASSETS,
};

/**
 * The registry follows the deployment's network. The server and the indexer
 * read `QWAKK_NETWORK` here; the browser has no access to it, so it starts on
 * the testnet registry and `components/useFeatures.ts` switches it with
 * `setAssetNetwork` as soon as `/api/features` reports the network.
 */
function initialAssetNetwork(): AssetNetworkId {
  const value = typeof process !== "undefined" && process.env ? process.env.QWAKK_NETWORK?.trim().toLowerCase() : undefined;
  return value === "mainnet" ? "mainnet" : "testnet";
}

let activeNetwork: AssetNetworkId = initialAssetNetwork();
let activeAssets: readonly QwakkAsset[] = ASSETS_BY_NETWORK[activeNetwork];
let ASSETS_BY_KEY = new Map(activeAssets.map((asset) => [asset.denom.toLowerCase(), asset]));

/** Switches the active registry. Idempotent. */
export function setAssetNetwork(network: AssetNetworkId) {
  if (network === activeNetwork || !(network in ASSETS_BY_NETWORK)) return;
  activeNetwork = network;
  activeAssets = ASSETS_BY_NETWORK[network];
  ASSETS_BY_KEY = new Map(activeAssets.map((asset) => [asset.denom.toLowerCase(), asset]));
}

/** The curated tokens of the active network. */
export function curatedAssets(): readonly QwakkAsset[] {
  return activeAssets;
}

/** The largest decimal setting `toBaseAmount` accepts (ERC20 tokens use up to 18). */
export const MAX_ASSET_DECIMALS = 18;

/** A curated asset. The lookup ignores case; the returned `denom` is the exact chain denom. */
export function assetForDenom(denom: string): QwakkAsset | undefined {
  return ASSETS_BY_KEY.get(denom.toLowerCase());
}

function shorten(value: string, head: number, tail: number) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/**
 * A short label for a denom. Curated tokens use their symbol; anything else
 * gets a compact form so a raw `erc20:0x…` or `ibc/…` string never fills the UI.
 */
export function displaySymbol(denom: string) {
  const asset = assetForDenom(denom);
  if (asset) return asset.symbol;
  const erc20 = /^erc20:(0x[0-9a-fA-F]{40})$/.exec(denom);
  if (erc20) return shorten(erc20[1], 6, 4);
  const ibc = /^ibc\/([0-9A-Fa-f]{64})$/.exec(denom);
  if (ibc) return `IBC ${shorten(ibc[1].toUpperCase(), 4, 4)}`;
  if (/^[a-z][a-z0-9]{1,15}$/.test(denom)) return denom.replace(/^u(?=[a-z])/, "").toUpperCase();
  const last = denom.split("/").pop() ?? denom;
  return shorten(last || denom, 8, 4);
}

function validDecimals(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 && number <= MAX_ASSET_DECIMALS ? number : null;
}

export type BankDenomMetadata = {
  base?: unknown;
  display?: unknown;
  name?: unknown;
  symbol?: unknown;
  denom_units?: unknown;
};

/**
 * Decimals from bank metadata: the highest unit exponent. Metadata that only
 * lists the exponent 0 base unit (as Diana's ATOM entry does) says nothing
 * about display decimals, so it gives null instead of 0.
 */
export function decimalsFromBankMetadata(metadata: BankDenomMetadata | null | undefined): number | null {
  const units = Array.isArray(metadata?.denom_units) ? metadata.denom_units as Array<{ exponent?: unknown }> : [];
  const exponents = units.map((unit) => unit?.exponent).filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);
  if (!exponents.length) return null;
  return validDecimals(Math.max(...exponents));
}

function cleanLabel(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value.trim()) ? value.trim() : "";
}

/** Resolves a denom from chain bank metadata. Curated values always win. */
export function assetFromBankMetadata(denom: string, metadata: BankDenomMetadata | null | undefined): ResolvedAsset {
  const curated = assetForDenom(denom);
  if (curated) return { ...curated, source: "curated" };
  if (!metadata) return unknownAsset(denom);
  const symbol = cleanLabel(metadata.symbol, /^[A-Za-z0-9.+_-]{1,16}$/) || cleanLabel(metadata.display, /^[A-Za-z0-9.+_-]{1,16}$/) || displaySymbol(denom);
  const name = cleanLabel(metadata.name, /^[A-Za-z0-9 .+_()-]{1,48}$/);
  return { denom, symbol, name: name && name !== denom ? name : symbol, decimals: decimalsFromBankMetadata(metadata), icon: "generic", source: "chain" };
}

/** A denom nothing is known about yet. */
export function unknownAsset(denom: string): ResolvedAsset {
  const symbol = displaySymbol(denom);
  return { denom, symbol, name: symbol, decimals: null, icon: "generic", source: "unknown" };
}

/**
 * Resolves a denom without a network read: curated first, then a hint from
 * indexed data. A hint of 0 decimals is treated as unknown, because the
 * indexer stores 0 when a token has no usable metadata.
 */
export function resolveAsset(denom: string, hint?: { symbol?: unknown; name?: unknown; decimals?: unknown }): ResolvedAsset {
  const curated = assetForDenom(denom);
  if (curated) return { ...curated, source: "curated" };
  const fallback = unknownAsset(denom);
  if (!hint) return fallback;
  const decimals = validDecimals(hint.decimals);
  const symbol = cleanLabel(hint.symbol, /^[A-Za-z0-9.+_-]{1,16}$/) || fallback.symbol;
  const name = cleanLabel(hint.name, /^[A-Za-z0-9 .+_()-]{1,48}$/) || symbol;
  return { ...fallback, symbol, name, decimals, source: decimals === null ? "unknown" : "chain" };
}

/**
 * Tokens offered when creating a pool: every curated token of the active
 * network (so Diana's faucet tokens show up even before the wallet holds
 * them), then any other denom the wallet holds. Each value is the exact
 * denom the chain reported when the wallet holds it, never a re-cased copy.
 */
export function createPoolTokenOptions(balances: ReadonlyMap<string, bigint> | null | undefined): string[] {
  const options = new Map(activeAssets.map((asset) => [asset.denom.toLowerCase(), asset.denom]));
  for (const [denom, amount] of balances ?? []) {
    if (amount > BigInt(0) || options.has(denom.toLowerCase())) options.set(denom.toLowerCase(), denom);
  }
  return [...options.values()];
}

type TokenPairRow = {
  token_a: string;
  token_b: string;
  token_a_symbol?: string;
  token_b_symbol?: string;
  token_a_name?: string | null;
  token_b_name?: string | null;
  token_a_decimals?: string | number | null;
  token_b_decimals?: string | number | null;
};

/**
 * Applies curated symbols, names and decimals to an indexed pool, market or
 * trade row, so a stale or incomplete token record never reaches the screen.
 */
export function withAssetOverrides<T extends TokenPairRow>(row: T): T {
  const a = assetForDenom(row.token_a);
  const b = assetForDenom(row.token_b);
  if (!a && !b) return row;
  const next = { ...row };
  if (a) Object.assign(next, { token_a_symbol: a.symbol, token_a_decimals: a.decimals, ...("token_a_name" in row ? { token_a_name: a.name } : {}) });
  if (b) Object.assign(next, { token_b_symbol: b.symbol, token_b_decimals: b.decimals, ...("token_b_name" in row ? { token_b_name: b.name } : {}) });
  return next;
}

/**
 * Formats an integer base amount for display. String math only, so 18-decimal
 * amounts stay exact. Extra fraction digits are cut, not rounded.
 */
export function formatBaseAmount(amount: string, decimals: number, maximumFractionDigits = 4) {
  if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) return amount;
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-decimals).slice(0, Math.max(0, maximumFractionDigits)).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The most fraction digits a tiny amount is given (18 covers every ERC20 token). */
const MAX_VISIBLE_FRACTION_DIGITS = MAX_ASSET_DECIMALS;
const VISIBLE_SIGNIFICANT_DIGITS = 4;

/**
 * Display only. Like `formatBaseAmount`, but a non-zero amount never reads as
 * "0": it gains fraction digits until four significant digits show (48000 wei
 * of an 18 decimal token is "0.000000000000048"). Only an amount finer than
 * 18 fraction digits would read as "< 0.000000000000000001".
 */
export function formatVisibleAmount(amount: string, decimals: number, maximumFractionDigits = 4) {
  const text = formatBaseAmount(amount, decimals, maximumFractionDigits);
  if (!/^\d+$/.test(amount) || BigInt(amount) === BigInt(0) || text !== "0" || !Number.isInteger(decimals) || decimals <= 0) return text;
  // The whole part is 0, so the amount fits in `decimals` fraction digits.
  const firstDigit = amount.padStart(decimals, "0").search(/[1-9]/);
  if (firstDigit + 1 > MAX_VISIBLE_FRACTION_DIGITS) return `< 0.${"0".repeat(MAX_VISIBLE_FRACTION_DIGITS - 1)}1`;
  return formatBaseAmount(amount, decimals, Math.min(decimals, MAX_VISIBLE_FRACTION_DIGITS, firstDigit + VISIBLE_SIGNIFICANT_DIGITS));
}

/** Converts a human-readable token amount to the chain's integer base unit. */
export function toBaseAmount(value: string, decimals: number) {
  const amount = value.trim();
  if (!/^\d*(?:\.\d*)?$/.test(amount) || amount === "" || amount === ".") {
    throw new Error("Enter a valid amount");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) throw new Error("Use a valid token decimal setting");

  const [wholeInput = "0", fractionInput = ""] = amount.split(".");
  if (fractionInput.length > decimals) throw new Error(decimals === 0 ? "This token takes whole amounts only" : `This token supports up to ${decimals} decimal places`);
  const whole = wholeInput || "0";
  const fraction = fractionInput.padEnd(decimals, "0");
  const base = BigInt(whole) * (BigInt(10) ** BigInt(decimals)) + BigInt(fraction || "0");
  if (base <= BigInt(0)) throw new Error("Amount must be greater than zero");
  return base.toString();
}
