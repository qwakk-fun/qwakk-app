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

/** Candle intervals the indexer writes, in seconds. */
export const CANDLE_INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "1h": 3600, "6h": 21600, "1d": 86400 };

/** How far back each chart interval reaches when served. Every written interval must be listed. */
export const CHART_WINDOWS: Record<string, string> = { "1m": "24 hours", "5m": "3 days", "1h": "30 days", "6h": "90 days", "1d": "365 days" };

export function bucketStart(date: Date, seconds: number) {
  return new Date(Math.floor(date.getTime() / (seconds * 1000)) * seconds * 1000);
}

export type SwapAmounts = { denomIn: string; amountIn: string; denomOut: string; amountOut: string };
export type PoolTokenInfo = { tokenA: string; tokenB: string; decimalsA: number; decimalsB: number; qorDecimals?: number };

/**
 * Price (token A in token B) and QOR volume of one swap. The price is null
 * when the swap denoms do not match the pool; the volume is null when neither
 * side is uqor, so non-QOR pools never report a made-up QOR volume.
 */
export function swapTrade(swap: SwapAmounts, pool: PoolTokenInfo) {
  const price = swap.denomIn === pool.tokenA && swap.denomOut === pool.tokenB
    ? priceBPerA(swap.amountIn, pool.decimalsA, swap.amountOut, pool.decimalsB)
    : swap.denomIn === pool.tokenB && swap.denomOut === pool.tokenA
      ? priceBPerA(swap.amountOut, pool.decimalsA, swap.amountIn, pool.decimalsB)
      : null;
  const qorDecimals = pool.qorDecimals ?? 6;
  const volumeQor = swap.denomIn === "uqor"
    ? toDisplayUnits(swap.amountIn, qorDecimals)
    : swap.denomOut === "uqor" ? toDisplayUnits(swap.amountOut, qorDecimals) : null;
  return { price, volumeQor };
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
  transactions: number;
};

/**
 * Applies one priced trade to every candle interval. This is the in-memory
 * twin of the candle upsert in server.ts: the first trade opens a bucket,
 * later trades widen high and low, move close and add volume.
 */
export function applyTradeToCandles(candles: Map<string, Candle>, executedAt: Date, price: string, volumeQor: string | null) {
  for (const [interval, seconds] of Object.entries(CANDLE_INTERVALS)) {
    const startTime = bucketStart(executedAt, seconds).toISOString();
    const key = `${interval}|${startTime}`;
    const existing = candles.get(key);
    if (!existing) {
      candles.set(key, { interval, startTime, open: price, high: price, low: price, close: price, volumeQor, transactions: 1 });
      continue;
    }
    existing.high = compareDecimal(price, existing.high) > 0 ? price : existing.high;
    existing.low = compareDecimal(price, existing.low) < 0 ? price : existing.low;
    existing.close = price;
    existing.volumeQor = existing.volumeQor === null && volumeQor === null ? null : addDecimal(existing.volumeQor ?? "0", volumeQor ?? "0");
    existing.transactions += 1;
  }
  return candles;
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
  const earlier = minute.filter((candle) => new Date(candle.startTime).getTime() <= since);
  const price = minute.at(-1)?.close ?? null;
  const price24hAgo = earlier.at(-1)?.close ?? null;
  return {
    volumeQor24h: volumes.length ? volumes.reduce(addDecimal) : null,
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
