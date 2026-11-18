export const CHART_INTERVALS = ["1m", "5m", "1h", "4h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

export const CHART_INTERVAL_LABELS: Record<ChartInterval, string> = {
  "1m": "1 minute candles, last 24 hours",
  "5m": "5 minute candles, last 3 days",
  "1h": "1 hour candles, last 30 days",
  "4h": "4 hour candles, last 60 days",
  "1d": "1 day candles, last year",
};

/** Bucket length in seconds. Buckets start on UTC multiples of it, as the indexer writes them. */
export const CHART_INTERVAL_SECONDS: Record<ChartInterval, number> = { "1m": 60, "5m": 300, "1h": 3_600, "4h": 14_400, "1d": 86_400 };

export function isChartInterval(value: string): value is ChartInterval {
  return (CHART_INTERVALS as readonly string[]).includes(value);
}

/** Empty chart copy: the longest interval has nothing to suggest. */
export function chartEmptyCopy(interval: ChartInterval) {
  return interval === "1d" ? "No trades yet in this pool." : "No trades yet in this pool for this range. Try a longer one.";
}

/** One `quote_candles` bucket as the indexer sends it: prices in quote per base, volume in the quote token. */
export type ChartCandleInput = {
  start_time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume?: string | number | null;
};

/** A bucket on the chart. `traded` is false for a quiet bucket, drawn flat at the last price. */
export type ChartBar = { time: number; open: number; high: number; low: number; close: number; volume: number | null; traded: boolean };
/** A slot before the first trade: it keeps the time axis honest without drawing a price. */
export type ChartBlank = { time: number };
export type ChartSlot = ChartBar | ChartBlank;

export function isChartBar(slot: ChartSlot): slot is ChartBar {
  return "close" in slot;
}

/** Fewest slots on screen, so one or two candles stay candle-sized instead of filling the chart. */
export const CHART_MIN_SLOTS = 48;
/** The longest window (1m over 24 hours) is 1440 buckets; anything beyond is trimmed from the old end. */
const CHART_MAX_SLOTS = 1_500;

function toNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Turns indexed candles into evenly spaced chart slots, so the time axis reads
 * as real time on a quiet pool:
 *
 * - each traded candle opens at the previous close (with no swaps in between,
 *   that is the price at the start of its bucket), so the chart reads as one
 *   continuous price path;
 * - a bucket with no trades between the first candle and now is drawn flat at
 *   the last price, marked `traded: false`;
 * - with fewer than `CHART_MIN_SLOTS` buckets, blank slots go before the first
 *   trade, so a new pool shows a few candles on a real time axis.
 */
export function buildChartSlots(candles: ChartCandleInput[], interval: ChartInterval, nowMs = Date.now()): ChartSlot[] {
  const step = CHART_INTERVAL_SECONDS[interval];
  const parsed = new Map<number, ChartBar>();
  for (const candle of candles) {
    const ms = new Date(candle.start_time).getTime();
    const open = toNumber(candle.open);
    const high = toNumber(candle.high);
    const low = toNumber(candle.low);
    const close = toNumber(candle.close);
    if (!Number.isFinite(ms) || open === null || high === null || low === null || close === null) continue;
    const time = Math.floor(ms / 1000 / step) * step;
    parsed.set(time, { time, open, high, low, close, volume: toNumber(candle.volume), traded: true });
  }
  const traded = [...parsed.values()].sort((a, b) => a.time - b.time);
  if (traded.length === 0) return [];

  const last = traded[traded.length - 1].time;
  const end = Math.max(last, Math.floor(nowMs / 1000 / step) * step);
  const start = Math.max(traded[0].time, end - (CHART_MAX_SLOTS - 1) * step);
  const slots: ChartSlot[] = [];
  let previous: number | null = null;
  // A candle trimmed off the old end still sets the price the next bucket opens at.
  for (const bar of traded) if (bar.time < start) previous = bar.close;
  for (let time = start; time <= end; time += step) {
    const bar = parsed.get(time);
    if (bar) {
      const open = previous ?? bar.open;
      slots.push({ ...bar, open, high: Math.max(bar.high, open), low: Math.min(bar.low, open) });
      previous = bar.close;
    } else if (previous !== null) {
      slots.push({ time, open: previous, high: previous, low: previous, close: previous, volume: null, traded: false });
    }
  }
  const blanks: ChartBlank[] = [];
  for (let index = CHART_MIN_SLOTS - slots.length; index > 0; index -= 1) blanks.push({ time: slots[0].time - index * step });
  return [...blanks, ...slots];
}

/** At least a 2% price range on screen, so a near-flat line sits mid-chart instead of swinging edge to edge. */
export const CHART_MIN_SPAN = 0.02;

/**
 * Fraction digits for one chart's prices: enough for four significant digits
 * at the top of the range and for fine steps between axis labels, never fewer
 * than two under 10,000. One count for the whole chart keeps axis labels the
 * same width, and a 0.0001 price never rounds to "0.00".
 */
export function chartPriceDecimals(values: number[]) {
  const prices = values.filter((value) => Number.isFinite(value) && value > 0);
  if (prices.length === 0) return 2;
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const span = Math.max(max - min, max * CHART_MIN_SPAN);
  const forSteps = Math.ceil(-Math.log10(span / 50));
  const forDigits = 3 - Math.floor(Math.log10(max));
  return Math.min(18, Math.max(0, forSteps, forDigits, max < 10_000 ? 2 : 0));
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const priceFormats = new Map<number, Intl.NumberFormat>();

/**
 * A chart price with a fixed number of decimals. Six or more leading zeros
 * fold into a subscript count, so 0.000000012345 reads "0.0₇12345".
 */
export function formatChartPrice(value: number, decimals: number) {
  if (!Number.isFinite(value)) return "";
  let format = priceFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    priceFormats.set(decimals, format);
  }
  const text = format.format(value);
  const match = /^(-?)0\.(0{6,})(\d+)$/.exec(text);
  if (!match) return text;
  const zeros = String(match[2].length).split("").map((digit) => SUBSCRIPT[Number(digit)]).join("");
  return `${match[1]}0.0${zeros}${match[3]}`;
}

const volumeCompact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const volumeSmall = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/** Bucket volume: compact from 1,000 up ("12.4K"), four significant digits below. */
export function formatChartVolume(value: number) {
  if (!Number.isFinite(value)) return "";
  return Math.abs(value) >= 1_000 ? volumeCompact.format(value) : volumeSmall.format(value);
}
