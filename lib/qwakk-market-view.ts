/**
 * How the app reads an indexed market for display. The indexer orients every
 * pool as base and quote (`quote_side`) and sends prices already in quote per
 * base display units (`price_quote`, `spot_price_quote`, `quote_candles`).
 * The raw `weighted_avg_price` is a base-unit ratio (off by 10^12 for fETH
 * against QOR) and is never shown. Pure, so the browser and tests share it.
 */
import { formatTokenAmount, resolveUsableAsset } from "./qwakk-asset-resolve";
import { curatedAssets } from "./qwakk-assets";

type Num = string | number | null | undefined;

export type LowLiquidityReason = "empty" | "dust_reserve" | "below_min_tvl" | "unknown_decimals";

/** The `/markets` row and `/pools/:id` pool fields this module reads. */
export type QuoteMarket = {
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: Num;
  token_b_decimals: Num;
  reserve_a?: string | null;
  reserve_b?: string | null;
  quote_side?: "a" | "b" | null;
  price_quote?: Num;
  price_quote_24h_ago?: Num;
  price_change_percent_24h?: Num;
  spot_price_quote?: Num;
  volume_quote_24h?: Num;
  tvl_quote?: Num;
  low_liquidity?: boolean | null;
  low_liquidity_reason?: string | null;
};

export type MarketSide = { denom: string; symbol: string; decimals: Num };

/**
 * Base and quote of a market. Symbols and decimals come from the token_a and
 * token_b fields, so curated overrides (`withAssetOverrides`) apply. Without a
 * `quote_side`, token B is the quote, as the indexer does for unranked pairs.
 */
export function marketSides(market: QuoteMarket): { base: MarketSide; quote: MarketSide } {
  const a = { denom: market.token_a, symbol: market.token_a_symbol, decimals: market.token_a_decimals };
  const b = { denom: market.token_b, symbol: market.token_b_symbol, decimals: market.token_b_decimals };
  return market.quote_side === "a" ? { base: b, quote: a } : { base: a, quote: b };
}

function finite(value: Num) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The latest price in quote per base: the last trade, else the spot price from reserves. */
export function marketPrice(market: QuoteMarket) {
  const value = finite(market.price_quote) ?? finite(market.spot_price_quote);
  return value !== null && value > 0 ? value : null;
}

/** "QOR per fETH". */
export function priceUnit(market: QuoteMarket) {
  const { base, quote } = marketSides(market);
  return `${quote.symbol} per ${base.symbol}`;
}

/** "fETH/QOR", base first. */
export function pairLabel(market: QuoteMarket, separator = "/") {
  const { base, quote } = marketSides(market);
  return `${base.symbol}${separator}${quote.symbol}`;
}

/**
 * A price for display. Large prices keep a few decimals; prices under 1 keep
 * four significant digits, so 0.00000123 never collapses to 0.
 */
export function formatQuotePrice(value: number) {
  if (!Number.isFinite(value)) return "Not available";
  const size = Math.abs(value);
  const options: Intl.NumberFormatOptions = size >= 1 ? { maximumFractionDigits: size >= 1_000 ? 2 : 4 } : { maximumSignificantDigits: 4 };
  return new Intl.NumberFormat("en-US", options).format(value);
}

/** 24h change in percent from the quote prices, or null when either price is missing. */
export function marketChange(market: QuoteMarket) {
  const reported = finite(market.price_change_percent_24h);
  if (reported !== null) return reported;
  const current = finite(market.price_quote);
  const previous = finite(market.price_quote_24h_ago);
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** 24h volume in the quote token, or null when the indexer has none. */
export function marketVolume(market: QuoteMarket) {
  const value = finite(market.volume_quote_24h);
  return { value, symbol: marketSides(market).quote.symbol };
}

export function isLowLiquidity(market: Pick<QuoteMarket, "low_liquidity">) {
  return market.low_liquidity === true;
}

/** Why a low-liquidity pool's price is not shown. Plain copy for each indexer reason. */
export function lowLiquidityCopy(reason: string | null | undefined) {
  switch (reason) {
    case "empty":
      return "This pool has no liquidity yet, so it has no usable price.";
    case "dust_reserve":
      return "This pool holds only a tiny amount of one token, so its price is not meaningful and even a small trade moves it a lot.";
    case "below_min_tvl":
      return "This pool holds very little value, so a small trade can move its price a lot.";
    case "unknown_decimals":
      return "Qwakk cannot confirm how many decimals one of these tokens uses, so this pool's price cannot be shown reliably.";
    default:
      return "This pool holds very little liquidity, so its price is not reliable.";
  }
}

/**
 * The indexer's reserve rules (indexer/market-math.ts `liquidityStatus` and
 * `dustThreshold`), for when its flag is not available: an empty side, or
 * either side under one millionth of a whole token with a 1000 base unit
 * floor. Fails closed: unreadable reserves count as empty and unknown
 * decimals as `unknown_decimals`. The TVL rule needs prices, so it is left
 * to the indexer.
 */
export function localLiquidityReason(reserveA: unknown, reserveB: unknown, decimalsA: number | null, decimalsB: number | null): LowLiquidityReason | null {
  if (typeof reserveA !== "string" || typeof reserveB !== "string" || !/^\d+$/.test(reserveA) || !/^\d+$/.test(reserveB)) return "empty";
  if (BigInt(reserveA) === BigInt(0) || BigInt(reserveB) === BigInt(0)) return "empty";
  if (decimalsA === null || decimalsB === null) return "unknown_decimals";
  if (BigInt(reserveA) < dustThreshold(decimalsA) || BigInt(reserveB) < dustThreshold(decimalsB)) return "dust_reserve";
  return null;
}

/** Smallest reserve that is not dust, in base units. Same rule as the indexer. */
export function dustThreshold(decimals: number) {
  const millionth = decimals > 6 ? BigInt(10) ** BigInt(decimals - 6) : BigInt(1);
  return millionth > BigInt(1000) ? millionth : BigInt(1000);
}

/** A reserve or amount with its symbol, labeled as base units when the decimals are unknown. */
export function sideAmount(amount: string | null | undefined, side: MarketSide, maximumFractionDigits = 4) {
  const decimals = resolveUsableAsset(side.denom, undefined, { decimals: side.decimals }).displayDecimals;
  return formatTokenAmount(amount ?? "0", decimals, side.symbol, maximumFractionDigits);
}

/** Both reserves for display, base first, each labeled as base units when its decimals are unknown. */
export function marketReserves(market: QuoteMarket, maximumFractionDigits = 4) {
  const { base, quote } = marketSides(market);
  const quoteIsA = market.quote_side === "a";
  return {
    base: sideAmount(quoteIsA ? market.reserve_b : market.reserve_a, base, maximumFractionDigits),
    quote: sideAmount(quoteIsA ? market.reserve_a : market.reserve_b, quote, maximumFractionDigits),
  };
}

function sameDenom(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** QOR, then each curated dollar token of the active network (fUSD on the testnet). */
export function pricingHubs() {
  return ["uqor", ...curatedAssets().filter((asset) => asset.icon === "usd").map((asset) => asset.denom)];
}

/** Price of `token` in `hub` from one usable pool, or null. */
function priceIn(markets: readonly QuoteMarket[], token: string, hub: string) {
  if (sameDenom(token, hub)) return 1;
  for (const market of markets) {
    if (isLowLiquidity(market)) continue;
    const price = marketPrice(market);
    if (price === null) continue;
    const { base, quote } = marketSides(market);
    if (sameDenom(base.denom, token) && sameDenom(quote.denom, hub)) return price;
    if (sameDenom(base.denom, hub) && sameDenom(quote.denom, token)) return 1 / price;
  }
  return null;
}

/**
 * The price of `denomA` in `denomB` (B per A) implied by existing pools that
 * are not flagged as low liquidity: a direct pool, or both tokens priced
 * against the same hub (QOR or a dollar token). Null when no path exists.
 */
export function impliedPairPrice(markets: readonly QuoteMarket[], denomA: string, denomB: string, hubs = pricingHubs()) {
  const direct = priceIn(markets, denomA, denomB);
  if (direct !== null) return { price: direct, via: null as string | null };
  for (const hub of hubs) {
    const a = priceIn(markets, denomA, hub);
    const b = priceIn(markets, denomB, hub);
    if (a !== null && b !== null && b > 0) return { price: a / b, via: hub };
  }
  return null;
}

/** Signed difference of `entered` from `reference`, in percent. */
export function priceDifferencePercent(entered: number, reference: number) {
  if (!Number.isFinite(entered) || !Number.isFinite(reference) || reference <= 0) return null;
  return ((entered - reference) / reference) * 100;
}

/** A starting price this far from the implied price gets a warning. */
export const START_PRICE_WARN_PERCENT = 10;
