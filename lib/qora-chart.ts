export const CHART_INTERVALS = ["1m", "5m", "1h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

export const CHART_INTERVAL_LABELS: Record<ChartInterval, string> = {
  "1m": "1 minute candles, last 24 hours",
  "5m": "5 minute candles, last 3 days",
  "1h": "1 hour candles, last 30 days",
  "1d": "1 day candles, last year",
};

export function isChartInterval(value: string): value is ChartInterval {
  return (CHART_INTERVALS as readonly string[]).includes(value);
}
