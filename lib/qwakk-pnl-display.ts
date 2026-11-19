import { formatVisibleAmount } from "./qwakk-assets";

/**
 * Display helpers for the profit and loss section of the portfolio page
 * (`GET /api/pnl`, contract in indexer/README.md). Every figure arrives as an
 * exact integer or decimal string and is formatted as a string: no float ever
 * touches a number the user reads, so 18 decimal tokens never drift. Figures
 * are truncated toward zero, never rounded up, so a gain never reads larger
 * than it is. Kept free of React so tests can call it.
 */

export type PnlCoverage = "complete" | "partial" | "none";
export type PnlTone = "up" | "down" | "flat";

export type PnlPrice = { qorPerToken: string | null; poolId: string; source: string; lowLiquidity: boolean };

export type PnlToken = {
  denom: string;
  symbol: string | null;
  decimals: number | null;
  held: string;
  bought: string;
  sold: string;
  buys: number;
  sells: number;
  costBasisAmount: string;
  costBasisUqor: string;
  averageCostQor: string | null;
  unknownCostAmount: string;
  untrackedOutflowAmount: string;
  price: PnlPrice | null;
  valueUqor: string | null;
  unrealizedPnlUqor: string | null;
  unrealizedPnlPercent: string | null;
  realizedPnlUqor: string;
  realizedUnknownAmount: string;
  costCoverage: PnlCoverage;
  dust: boolean;
};

export type PnlTotals = {
  valueUqor: string;
  costBasisUqor: string;
  unrealizedPnlUqor: string;
  unrealizedPnlPercent: string | null;
  realizedPnlUqor: string;
  unpricedTokens: number;
  coverage: PnlCoverage;
};

export type PnlHistory = {
  fromHeight: number | null;
  fromTime: string | null;
  source: string | null;
  indexedHeight: number | null;
  gap: { fromHeight: number; toHeight: number } | null;
};

export type PnlReport = {
  address: string;
  history: PnlHistory;
  swapsCounted: number;
  totals: PnlTotals;
  tokens: PnlToken[];
};

const UNSIGNED = /^\d+$/;
const SIGNED = /^-?\d+$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const QOR_DECIMALS = 6;
/** One thousand QOR in uqor: from here on two fraction digits are enough. */
const THOUSAND_QOR = BigInt(1_000_000_000);
const ONE_QOR = BigInt(1_000_000);
const MINUS = "−";

function isUnsigned(value: unknown): value is string {
  return typeof value === "string" && UNSIGNED.test(value);
}
function isSigned(value: unknown): value is string {
  return typeof value === "string" && SIGNED.test(value);
}
function isDecimalOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DECIMAL.test(value));
}
function isCoverage(value: unknown): value is PnlCoverage {
  return value === "complete" || value === "partial" || value === "none";
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePrice(value: unknown): PnlPrice | null | undefined {
  if (value === null) return null;
  const price = value as Partial<PnlPrice> | undefined;
  if (!price || typeof price !== "object" || !isDecimalOrNull(price.qorPerToken ?? null)) return undefined;
  return { qorPerToken: price.qorPerToken ?? null, poolId: String(price.poolId ?? ""), source: String(price.source ?? ""), lowLiquidity: price.lowLiquidity === true };
}

function parseToken(value: unknown): PnlToken | null {
  const token = value as Partial<PnlToken> | null;
  if (!token || typeof token !== "object" || typeof token.denom !== "string" || !token.denom) return null;
  const decimals = token.decimals === null ? null : Number.isInteger(token.decimals) && (token.decimals as number) >= 0 && (token.decimals as number) <= 18 ? token.decimals as number : undefined;
  const price = parsePrice(token.price);
  const amounts = [token.held, token.bought, token.sold, token.costBasisAmount, token.costBasisUqor, token.unknownCostAmount, token.untrackedOutflowAmount, token.realizedUnknownAmount];
  if (decimals === undefined || price === undefined || !amounts.every(isUnsigned)) return null;
  if (!isSigned(token.realizedPnlUqor) || !(token.valueUqor === null || isUnsigned(token.valueUqor)) || !(token.unrealizedPnlUqor === null || isSigned(token.unrealizedPnlUqor))) return null;
  if (!isDecimalOrNull(token.averageCostQor) || !isDecimalOrNull(token.unrealizedPnlPercent)) return null;
  return {
    denom: token.denom,
    symbol: typeof token.symbol === "string" && token.symbol ? token.symbol : null,
    decimals,
    held: token.held as string,
    bought: token.bought as string,
    sold: token.sold as string,
    buys: isCount(token.buys) ? token.buys : 0,
    sells: isCount(token.sells) ? token.sells : 0,
    costBasisAmount: token.costBasisAmount as string,
    costBasisUqor: token.costBasisUqor as string,
    averageCostQor: token.averageCostQor,
    unknownCostAmount: token.unknownCostAmount as string,
    untrackedOutflowAmount: token.untrackedOutflowAmount as string,
    price,
    valueUqor: token.valueUqor,
    unrealizedPnlUqor: token.unrealizedPnlUqor,
    unrealizedPnlPercent: token.unrealizedPnlPercent,
    realizedPnlUqor: token.realizedPnlUqor,
    realizedUnknownAmount: token.realizedUnknownAmount as string,
    costCoverage: isCoverage(token.costCoverage) ? token.costCoverage : "partial",
    dust: token.dust === true,
  };
}

/**
 * Checks a `/api/pnl` body before anything renders it. A body with broken
 * totals is rejected (null); a single malformed token row is dropped and the
 * coverage turns partial, so the page never shows a made-up number.
 */
export function parsePnlReport(data: unknown): PnlReport | null {
  const body = data as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return null;
  const totals = body.totals as Partial<PnlTotals> | undefined;
  if (!totals || typeof totals !== "object") return null;
  if (!isUnsigned(totals.valueUqor) || !isUnsigned(totals.costBasisUqor) || !isSigned(totals.unrealizedPnlUqor) || !isSigned(totals.realizedPnlUqor)) return null;
  if (!isDecimalOrNull(totals.unrealizedPnlPercent ?? null) || !isCoverage(totals.coverage) || !isCount(totals.unpricedTokens)) return null;
  if (!Array.isArray(body.tokens) || !isCount(body.swapsCounted)) return null;
  const tokens = body.tokens.map(parseToken);
  const valid = tokens.filter((token): token is PnlToken => token !== null);
  const history = (body.history && typeof body.history === "object" ? body.history : {}) as Partial<PnlHistory>;
  const gap = history.gap && typeof history.gap === "object" && isCount(history.gap.fromHeight) && isCount(history.gap.toHeight) ? { fromHeight: history.gap.fromHeight, toHeight: history.gap.toHeight } : null;
  return {
    address: typeof body.address === "string" ? body.address : "",
    history: {
      fromHeight: isCount(history.fromHeight) ? history.fromHeight : null,
      fromTime: typeof history.fromTime === "string" ? history.fromTime : null,
      source: typeof history.source === "string" ? history.source : null,
      indexedHeight: isCount(history.indexedHeight) ? history.indexedHeight : null,
      gap,
    },
    swapsCounted: body.swapsCounted,
    totals: {
      valueUqor: totals.valueUqor,
      costBasisUqor: totals.costBasisUqor,
      unrealizedPnlUqor: totals.unrealizedPnlUqor,
      unrealizedPnlPercent: totals.unrealizedPnlPercent ?? null,
      realizedPnlUqor: totals.realizedPnlUqor,
      unpricedTokens: totals.unpricedTokens,
      coverage: valid.length < tokens.length && totals.coverage === "complete" ? "partial" : totals.coverage,
    },
    tokens: valid,
  };
}

/** Thousands separators on the whole part of a plain decimal string. */
export function groupDigits(value: string) {
  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Gain, loss or neither, from a signed integer or decimal string. Anything unreadable is flat. */
export function pnlTone(value: string | null | undefined): PnlTone {
  if (typeof value !== "string" || !DECIMAL.test(value)) return "flat";
  if (!/[1-9]/.test(value)) return "flat";
  return value.startsWith("-") ? "down" : "up";
}

function splitSign(value: string) {
  return value.startsWith("-") ? { negative: true, digits: value.slice(1) } : { negative: false, digits: value };
}

/**
 * A uqor amount in QOR, without sign: four fraction digits below 1,000 QOR,
 * two above, and a non-zero amount under 0.0001 QOR keeps its digits instead
 * of reading as 0. Not a number: "0".
 */
export function formatQor(uqor: string | null | undefined) {
  if (typeof uqor !== "string" || !SIGNED.test(uqor)) return "0";
  const { digits } = splitSign(uqor);
  const fraction = BigInt(digits) >= THOUSAND_QOR ? 2 : 4;
  return groupDigits(formatVisibleAmount(digits.replace(/^0+(?=\d)/, ""), QOR_DECIMALS, fraction));
}

/** A signed uqor amount in QOR with an explicit "+" or "−": "+1.5", "−0.25", "0". */
export function formatSignedQor(uqor: string | null | undefined) {
  const text = formatQor(uqor);
  const tone = pnlTone(uqor);
  return tone === "up" ? `+${text}` : tone === "down" ? `${MINUS}${text}` : text;
}

/** True when a uqor amount is at least one whole QOR away from zero (used to size the headline). */
export function isWholeQor(uqor: string) {
  return SIGNED.test(uqor) && BigInt(splitSign(uqor).digits) >= ONE_QOR;
}

/**
 * A percent change for display. The arrow and the word let the direction
 * read without color: `{ tone: "down", arrow: "▼", word: "down", text: "12.5%" }`.
 * Null (no known cost) stays null.
 */
export function formatPnlPercent(percent: string | null | undefined) {
  if (typeof percent !== "string" || !DECIMAL.test(percent)) return null;
  const tone = pnlTone(percent);
  const { digits } = splitSign(percent);
  const [whole, fraction = ""] = digits.split(".");
  const cut = fraction.slice(0, 2).replace(/0+$/, "");
  const text = `${groupDigits(whole.replace(/^0+(?=\d)/, ""))}${cut ? `.${cut}` : ""}%`;
  return { tone, arrow: tone === "up" ? "▲" : tone === "down" ? "▼" : "", word: tone === "up" ? "up" : tone === "down" ? "down" : "", text };
}

/**
 * A token amount in base units for display. A token with unknown decimals
 * shows its raw base units, labeled as such, like the rest of the page.
 */
export function formatTokenAmount(base: string, decimals: number | null) {
  if (!UNSIGNED.test(base)) return "0";
  if (decimals === null) return `${groupDigits(base.replace(/^0+(?=\d)/, ""))} base units`;
  return groupDigits(formatVisibleAmount(base, decimals, 4));
}

/**
 * QOR per whole token from an exact decimal string (up to 18 fraction digits).
 * Two fraction digits from 1,000 QOR, four from 1 QOR, and below 1 QOR four
 * significant digits, so a tiny price like 0.000000001234 still reads.
 */
export function formatQorPerToken(value: string | null | undefined) {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const { negative, digits } = splitSign(value);
  const [rawWhole, rawFraction = ""] = digits.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  let fraction: string;
  if (whole !== "0") {
    fraction = rawFraction.slice(0, whole.length >= 4 ? 2 : 4);
  } else {
    const first = rawFraction.search(/[1-9]/);
    if (first === -1) return "0";
    fraction = rawFraction.slice(0, Math.min(18, first + 4));
  }
  fraction = fraction.replace(/0+$/, "");
  const text = groupDigits(fraction ? `${whole}.${fraction}` : whole);
  return negative && /[1-9]/.test(text) ? `${MINUS}${text}` : text;
}

/** True when a base-unit amount is above zero. */
export function isPositiveAmount(value: string) {
  return UNSIGNED.test(value) && /[1-9]/.test(value);
}

/** "2026-11-12T08:14:03Z" as "Nov 12, 2026", read as a UTC day. Null when unreadable. */
export function formatPnlDay(iso: string | null | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

/** The history line in the section header. */
export function pnlHistoryLine(history: Pick<PnlHistory, "fromTime"> | null | undefined) {
  const day = formatPnlDay(history?.fromTime);
  return day ? `Counting swaps since ${day}` : "Counting every swap we have on record";
}

/** Splits rows into the ones shown by default and the small balances behind the toggle. */
export function splitDust(tokens: readonly PnlToken[]) {
  const main: PnlToken[] = [];
  const dust: PnlToken[] = [];
  for (const token of tokens) (token.dust ? dust : main).push(token);
  return { main, dust };
}

/**
 * True when the token's price comes from a pool the markets page flags as low
 * liquidity. Such a price is shown with its "Small pool" tag but never values
 * the holding: the API leaves it out of value, profit and loss and totals, and
 * the page says so even if an older API still sent a value.
 */
export function isSmallPoolPrice(token: Pick<PnlToken, "price">) {
  return token.price?.lowLiquidity === true;
}

/** True when any held token is left unpriced because its pool is too small. */
export function hasLowLiquidityPrice(tokens: readonly PnlToken[]) {
  return tokens.some((token) => isSmallPoolPrice(token) && isPositiveAmount(token.held));
}

export const SMALL_POOL_COPY = "Pool too small to price";

/** The Value cell: a QOR figure, or why there is none. */
export function pnlValueCell(token: Pick<PnlToken, "price" | "valueUqor">): { uqor: string } | { text: string } {
  if (isSmallPoolPrice(token)) return { text: SMALL_POOL_COPY };
  return token.valueUqor !== null ? { uqor: token.valueUqor } : { text: "Not priced" };
}

/** The "On what you hold" cell: a signed QOR figure with its percent, or why there is none. */
export function pnlUnrealizedCell(token: Pick<PnlToken, "price" | "held" | "unrealizedPnlUqor" | "unrealizedPnlPercent">): { uqor: string; percent: string | null } | { text: string } {
  const held = isPositiveAmount(token.held);
  if (held && isSmallPoolPrice(token)) return { text: SMALL_POOL_COPY };
  if (token.unrealizedPnlUqor !== null && !isSmallPoolPrice(token)) return { uqor: token.unrealizedPnlUqor, percent: token.unrealizedPnlPercent };
  return { text: !held ? "Nothing left" : token.price ? "Buy price unknown" : "Not counted" };
}

/** Fixed copy for every failed read: route, indexer or proxy text never reaches the page. */
export const PNL_ERROR_COPY = {
  busy: { title: "Too many swaps to add up", body: "This wallet has more swaps than we can count in one go right now. Give it a little while." },
  unavailable: { title: "Numbers are catching up", body: "We could not load your swap history just now. Give it a moment." },
} as const;

export type PnlErrorKind = keyof typeof PNL_ERROR_COPY;

/** 422 means too many swaps to replay; every other failure (503, network, bad body) is "unavailable". */
export function pnlErrorKind(status: number | null): PnlErrorKind {
  return status === 422 ? "busy" : "unavailable";
}
