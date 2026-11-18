/** Decimal places kept for prices written to PostgreSQL NUMERIC columns. */
export const PRICE_SCALE = 18;

function assertBaseAmount(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("Amounts must be non-negative integers");
}

function assertDecimals(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error("Decimals must be an integer between 0 and 36");
}

/** Formats a scaled integer as a plain decimal string without trailing zeros. */
function toDecimalString(scaled: bigint, scale: number) {
  const digits = scaled.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Converts a base-unit amount to display units, exactly. */
export function toDisplayUnits(amount: string, decimals: number) {
  assertBaseAmount(amount);
  assertDecimals(decimals);
  return toDecimalString(BigInt(amount), decimals);
}

/**
 * Price of token A expressed in token B, from one swap's base-unit amounts:
 * (amountB / 10^decimalsB) / (amountA / 10^decimalsA). Integer arithmetic only,
 * truncated to PRICE_SCALE decimals. Returns null when amount A is zero.
 */
export function priceBPerA(amountA: string, decimalsA: number, amountB: string, decimalsB: number) {
  assertBaseAmount(amountA);
  assertBaseAmount(amountB);
  assertDecimals(decimalsA);
  assertDecimals(decimalsB);
  if (BigInt(amountA) === BigInt(0)) return null;

  const ten = BigInt(10);
  const numerator = BigInt(amountB) * ten ** BigInt(decimalsA + PRICE_SCALE);
  const denominator = BigInt(amountA) * ten ** BigInt(decimalsB);
  return toDecimalString(numerator / denominator, PRICE_SCALE);
}

/**
 * Candle intervals the indexer writes, in seconds. Buckets are aligned to the
 * Unix epoch, so 4h candles start at 00, 04, 08, 12, 16 and 20 UTC. 6h candles
 * were written before 4h replaced them; their rows stay in the table unused.
 */
export const CANDLE_INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "4h": 14400, "1d": 86400 };

/**
 * How far back each chart interval reaches when served. Every written interval
 * must be listed, and only listed intervals are served. 60 days of 4h is 360
 * candles, the same density the 6h chart had over 90 days.
 */
export const CHART_WINDOWS: Record<string, string> = { "1m": "24 hours", "5m": "3 days", "1h": "30 days", "4h": "60 days", "1d": "365 days" };

/**
 * Intervals the indexer fills from a finer stored interval on start, for
 * history recorded before the interval existed. The source must divide the
 * target evenly and must never be pruned (1h candles are kept forever).
 */
export const CANDLE_ROLLUPS: ReadonlyArray<{ target: string; source: string }> = [{ target: "4h", source: "1h" }];

export function bucketStart(date: Date, seconds: number) {
  return new Date(Math.floor(date.getTime() / (seconds * 1000)) * seconds * 1000);
}

export type SwapAmounts = { denomIn: string; amountIn: string; denomOut: string; amountOut: string };
export type QuoteSide = "a" | "b";
export type PoolTokenInfo = { tokenA: string; tokenB: string; decimalsA: number; decimalsB: number; qorDecimals?: number; quoteSide?: QuoteSide };

/**
 * Which token of a pair prices the other. Ranked tokens (QOR, then
 * stable-like tokens) win; between two unranked tokens token B is the quote,
 * so the stored price B per A already reads as quote per base.
 */
export function chooseQuoteSide(rankA: number | null, rankB: number | null): QuoteSide {
  if (rankA !== null && (rankB === null || rankA < rankB)) return "a";
  return "b";
}

/**
 * Price (token A in token B), QOR volume and quote volume of one swap. The
 * price is null when the swap denoms do not match the pool; the QOR volume is
 * null when neither side is uqor, so non-QOR pools never report a made-up QOR
 * volume. The quote volume is the quote token's side of the swap, in display units.
 */
export function swapTrade(swap: SwapAmounts, pool: PoolTokenInfo) {
  const forward = swap.denomIn === pool.tokenA && swap.denomOut === pool.tokenB;
  const reverse = swap.denomIn === pool.tokenB && swap.denomOut === pool.tokenA;
  const price = forward
    ? priceBPerA(swap.amountIn, pool.decimalsA, swap.amountOut, pool.decimalsB)
    : reverse
      ? priceBPerA(swap.amountOut, pool.decimalsA, swap.amountIn, pool.decimalsB)
      : null;
  const qorDecimals = pool.qorDecimals ?? 6;
  const volumeQor = swap.denomIn === "uqor"
    ? toDisplayUnits(swap.amountIn, qorDecimals)
    : swap.denomOut === "uqor" ? toDisplayUnits(swap.amountOut, qorDecimals) : null;
  const quoteDenom = (pool.quoteSide ?? "b") === "a" ? pool.tokenA : pool.tokenB;
  const quoteDecimals = (pool.quoteSide ?? "b") === "a" ? pool.decimalsA : pool.decimalsB;
  const volumeQuote = !forward && !reverse
    ? null
    : swap.denomIn === quoteDenom ? toDisplayUnits(swap.amountIn, quoteDecimals) : toDisplayUnits(swap.amountOut, quoteDecimals);
  return { price, volumeQor, volumeQuote };
}

function toScaled(value: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] ?? "").length > PRICE_SCALE) throw new Error("Decimals must be plain non-negative numbers");
  return BigInt(match[1]) * BigInt(10) ** BigInt(PRICE_SCALE) + BigInt((match[2] ?? "").padEnd(PRICE_SCALE, "0") || "0");
}

export function compareDecimal(a: string, b: string) {
  const left = toScaled(a);
  const right = toScaled(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

export function addDecimal(a: string, b: string) {
  return toDecimalString(toScaled(a) + toScaled(b), PRICE_SCALE);
}

export type Candle = {
  interval: string;
  startTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeQor: string | null;
  /** Volume in the pool's quote token, display units. */
  volumeQuote?: string | null;
  transactions: number;
};

/**
 * Applies one priced trade to every candle interval. This is the in-memory
 * twin of the candle upsert in server.ts: the first trade opens a bucket,
 * later trades widen high and low, move close and add volume.
 */
export function applyTradeToCandles(candles: Map<string, Candle>, executedAt: Date, price: string, volumeQor: string | null, volumeQuote: string | null = null) {
  for (const [interval, seconds] of Object.entries(CANDLE_INTERVALS)) {
    const startTime = bucketStart(executedAt, seconds).toISOString();
    const key = `${interval}|${startTime}`;
    const existing = candles.get(key);
    if (!existing) {
      candles.set(key, { interval, startTime, open: price, high: price, low: price, close: price, volumeQor, volumeQuote, transactions: 1 });
      continue;
    }
    existing.high = compareDecimal(price, existing.high) > 0 ? price : existing.high;
    existing.low = compareDecimal(price, existing.low) < 0 ? price : existing.low;
    existing.close = price;
    existing.volumeQor = existing.volumeQor === null && volumeQor === null ? null : addDecimal(existing.volumeQor ?? "0", volumeQor ?? "0");
    const previousQuote = existing.volumeQuote ?? null;
    existing.volumeQuote = previousQuote === null && volumeQuote === null ? null : addDecimal(previousQuote ?? "0", volumeQuote ?? "0");
    existing.transactions += 1;
  }
  return candles;
}

/**
 * Rolls finer candles of one pool up into `target` candles. This is the
 * in-memory twin of the startup backfill in server.ts (backfillRolledUpCandles):
 * open is the earliest open, close the latest close, high and low the extremes,
 * volumes and transactions are summed. A null volume_quote counts as
 * volume_qor, like every reader of the candles table.
 */
export function rollUpCandles(candles: Candle[], target: string, seconds: number) {
  const rolled = new Map<string, Candle>();
  const ordered = [...candles].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (const candle of ordered) {
    const startTime = bucketStart(new Date(candle.startTime), seconds).toISOString();
    const quote = candle.volumeQuote ?? candle.volumeQor;
    const existing = rolled.get(startTime);
    if (!existing) {
      rolled.set(startTime, { ...candle, interval: target, startTime, volumeQuote: quote });
      continue;
    }
    existing.high = compareDecimal(candle.high, existing.high) > 0 ? candle.high : existing.high;
    existing.low = compareDecimal(candle.low, existing.low) < 0 ? candle.low : existing.low;
    existing.close = candle.close;
    existing.volumeQor = existing.volumeQor === null && candle.volumeQor === null ? null : addDecimal(existing.volumeQor ?? "0", candle.volumeQor ?? "0");
    existing.volumeQuote = (existing.volumeQuote ?? null) === null && quote === null ? null : addDecimal(existing.volumeQuote ?? "0", quote ?? "0");
    existing.transactions += candle.transactions;
  }
  return [...rolled.values()];
}

/**
 * 24h market figures from 1m candles, matching the /markets query: volume is
 * the sum of the last 24 hours, the price is the latest close and the 24h ago
 * price is the latest close at or before 24 hours ago.
 */
export function marketSummary(candles: Candle[], now: Date) {
  const minute = candles.filter((candle) => candle.interval === "1m").sort((a, b) => a.startTime.localeCompare(b.startTime));
  const since = now.getTime() - 86_400_000;
  const recent = minute.filter((candle) => new Date(candle.startTime).getTime() >= since);
  const volumes = recent.map((candle) => candle.volumeQor).filter((value): value is string => value !== null);
  const quoteVolumes = recent.map((candle) => candle.volumeQuote ?? candle.volumeQor).filter((value): value is string => value !== null);
  const earlier = minute.filter((candle) => new Date(candle.startTime).getTime() <= since);
  const price = minute.at(-1)?.close ?? null;
  const price24hAgo = earlier.at(-1)?.close ?? null;
  return {
    volumeQor24h: volumes.length ? volumes.reduce(addDecimal) : null,
    volumeQuote24h: quoteVolumes.length ? quoteVolumes.reduce(addDecimal) : null,
    transactions24h: recent.reduce((sum, candle) => sum + candle.transactions, 0),
    price,
    price24hAgo,
    priceChangePercent: price !== null && price24hAgo !== null ? priceChangePercent(price, price24hAgo) : null,
  };
}

/** Percent change from `previous` to `current`, exact to 4 decimals (truncated toward zero). Null when previous is 0. */
export function priceChangePercent(current: string, previous: string) {
  const before = toScaled(previous);
  if (before === BigInt(0)) return null;
  const delta = toScaled(current) - before;
  const scaled = (delta * BigInt(1000000)) / before; // percent times 10^4
  const negative = scaled < BigInt(0);
  const text = toDecimalString(negative ? -scaled : scaled, 4);
  return `${negative ? "-" : ""}${text}`;
}

/**
 * 1 / price, truncated to PRICE_SCALE decimals. Used to turn a stored price
 * B per A into quote per base when token A is the quote. Null for zero.
 */
export function invertPrice(price: string) {
  const scaled = toScaled(price);
  if (scaled === BigInt(0)) return null;
  return toDecimalString((BigInt(10) ** BigInt(2 * PRICE_SCALE)) / scaled, PRICE_SCALE);
}

/** A stored price B per A, read as quote per base. */
export function priceInQuote(priceBPerA: string | null, quoteSide: QuoteSide) {
  if (priceBPerA === null) return null;
  return quoteSide === "b" ? toDecimalString(toScaled(priceBPerA), PRICE_SCALE) : invertPrice(priceBPerA);
}

export type PriceCandle = { open: string; high: string; low: string; close: string };

/** A B-per-A candle read as quote per base. Inverting swaps high and low. */
export function candleInQuote<T extends PriceCandle>(candle: T, quoteSide: QuoteSide): T | null {
  if (quoteSide === "b") return candle;
  const open = invertPrice(candle.open);
  const high = invertPrice(candle.low);
  const low = invertPrice(candle.high);
  const close = invertPrice(candle.close);
  if (open === null || high === null || low === null || close === null) return null;
  return { ...candle, open, high, low, close };
}

export function multiplyDecimal(a: string, b: string) {
  return toDecimalString((toScaled(a) * toScaled(b)) / BigInt(10) ** BigInt(PRICE_SCALE), PRICE_SCALE);
}

export type PoolReserves = {
  poolType: string;
  reserveA: string;
  reserveB: string;
  decimalsA: number;
  decimalsB: number;
  quoteSide: QuoteSide;
};

function sides(pool: PoolReserves) {
  return pool.quoteSide === "b"
    ? { base: pool.reserveA, baseDecimals: pool.decimalsA, quote: pool.reserveB, quoteDecimals: pool.decimalsB }
    : { base: pool.reserveB, baseDecimals: pool.decimalsB, quote: pool.reserveA, quoteDecimals: pool.decimalsA };
}

/** Decimal-adjusted reserve ratio, quote per base. Null when the base reserve is empty. */
export function spotPriceInQuote(pool: PoolReserves) {
  const { base, baseDecimals, quote, quoteDecimals } = sides(pool);
  if (!/^\d+$/.test(base) || !/^\d+$/.test(quote)) return null;
  return priceBPerA(base, baseDecimals, quote, quoteDecimals);
}

/**
 * Pool value in the quote token, display units. A constant product pool holds
 * equal value on both sides at its spot price, so TVL is twice the quote
 * reserve. Other curves need a traded price for the base side; without one
 * the TVL is unknown (null).
 */
export function poolTvlInQuote(pool: PoolReserves, lastPriceInQuote: string | null) {
  const { base, baseDecimals, quote, quoteDecimals } = sides(pool);
  if (!/^\d+$/.test(base) || !/^\d+$/.test(quote) || baseDecimals > PRICE_SCALE || quoteDecimals > PRICE_SCALE) return null;
  const quoteUnits = toDisplayUnits(quote, quoteDecimals);
  if (pool.poolType === "constant_product") return addDecimal(quoteUnits, quoteUnits);
  if (lastPriceInQuote === null) return null;
  return addDecimal(quoteUnits, multiplyDecimal(toDisplayUnits(base, baseDecimals), lastPriceInQuote));
}

/**
 * Smallest reserve, in base units, that is not dust: one millionth of a whole
 * token, and never below the AMM's 1000 unit minimum liquidity.
 */
export function dustThreshold(decimals: number) {
  assertDecimals(decimals);
  const ten = BigInt(10);
  const millionth = decimals > 6 ? ten ** BigInt(decimals - 6) : BigInt(1);
  return millionth > BigInt(1000) ? millionth : BigInt(1000);
}

export type LiquidityStatus = { lowLiquidity: boolean; reason: "unknown_decimals" | "empty" | "dust_reserve" | "below_min_tvl" | null };

/**
 * Flags pools whose price cannot be trusted: an empty side, a dust reserve on
 * either side, or a TVL under the quote token's minimum. The pool stays
 * listed; the UI decides how to mark or hide it.
 */
export function liquidityStatus(pool: PoolReserves, tvlInQuote: string | null, minTvl: string | null): LiquidityStatus {
  if (!/^\d+$/.test(pool.reserveA) || !/^\d+$/.test(pool.reserveB)) return { lowLiquidity: true, reason: "empty" };
  const reserveA = BigInt(pool.reserveA);
  const reserveB = BigInt(pool.reserveB);
  if (reserveA === BigInt(0) || reserveB === BigInt(0)) return { lowLiquidity: true, reason: "empty" };
  if (reserveA < dustThreshold(pool.decimalsA) || reserveB < dustThreshold(pool.decimalsB)) return { lowLiquidity: true, reason: "dust_reserve" };
  if (tvlInQuote !== null && minTvl !== null && compareDecimal(tvlInQuote, minTvl) < 0) return { lowLiquidity: true, reason: "below_min_tvl" };
  return { lowLiquidity: false, reason: null };
}

/** Market math on stored values; a value it cannot read exactly becomes null instead of failing the response. */
function exact<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

export type PairInput = {
  poolType: string;
  /** Null when the token's decimals are unknown. */
  decimalsA: number | null;
  decimalsB: number | null;
  reserveA: string | null;
  reserveB: string | null;
  /** Latest and 24h-ago trade prices as stored (token B per token A). */
  priceBPerA: string | null;
  price24hAgoBPerA: string | null;
  volumeQuote24h: string | null;
  quoteSide: QuoteSide;
  minTvl: string | null;
};

/**
 * Quote-oriented market figures for one pool. A pool with a token of unknown
 * decimals is unpriced: every price, volume and TVL figure is null and it is
 * flagged low liquidity with reason "unknown_decimals", so nothing is computed
 * from a guessed decimal count.
 */
export function pairFigures(input: PairInput) {
  if (input.decimalsA === null || input.decimalsB === null) {
    return {
      decimalsKnown: false,
      priceQuote: null,
      priceQuote24hAgo: null,
      priceChangePercent24h: null,
      spotPriceQuote: null,
      spotPriceBPerA: null,
      volumeQuote24h: null,
      tvlQuote: null,
      liquidity: { lowLiquidity: true, reason: "unknown_decimals" } as LiquidityStatus,
    };
  }
  const reserves: PoolReserves = {
    poolType: input.poolType,
    reserveA: input.reserveA ?? "0",
    reserveB: input.reserveB ?? "0",
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    quoteSide: input.quoteSide,
  };
  const priceQuote = exact(() => priceInQuote(input.priceBPerA, input.quoteSide));
  const priceQuote24hAgo = exact(() => priceInQuote(input.price24hAgoBPerA, input.quoteSide));
  const tvlQuote = exact(() => poolTvlInQuote(reserves, priceQuote));
  return {
    decimalsKnown: true,
    priceQuote,
    priceQuote24hAgo,
    priceChangePercent24h: priceQuote !== null && priceQuote24hAgo !== null ? exact(() => priceChangePercent(priceQuote, priceQuote24hAgo)) : null,
    spotPriceQuote: exact(() => spotPriceInQuote(reserves)),
    spotPriceBPerA: exact(() => spotPriceInQuote({ ...reserves, quoteSide: "b" })),
    volumeQuote24h: input.volumeQuote24h,
    tvlQuote,
    liquidity: liquidityStatus(reserves, tvlQuote, input.minTvl),
  };
}

/** Stored decimals as read from PostgreSQL: a non-negative integer, or null when unknown. */
export function knownDecimals(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 36 ? number : null;
}
