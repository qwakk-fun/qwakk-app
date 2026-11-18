"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartCandlestick } from "lucide-react";
import { CandlestickSeries, HistogramSeries, LineStyle, createChart, type AutoscaleInfo, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CHART_INTERVAL_SECONDS, CHART_MIN_SPAN, buildChartSlots, chartPriceDecimals, formatChartPrice, formatChartVolume, isChartBar, type ChartBar, type ChartCandleInput, type ChartInterval } from "../lib/qwakk-chart";
import { chartBaseOptions, chartTimeOptions } from "../lib/qwakk-chart-style";
import { THEME } from "../lib/theme";

/** One `quote_candles` bucket from `/api/pools/:id`: prices in quote per base, volume in the quote token. */
export type PoolCandle = ChartCandleInput;

/** Never narrower than this per bucket by default; older buckets are a drag away. */
const MIN_BAR_PX = 6;
/** The price axis takes about this much of the width. */
const PRICE_AXIS_PX = 84;

const legendTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const legendDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * A pool's price as candles in quote per base, with neutral volume bars
 * underneath. Quiet buckets are drawn flat in gray, so only real trades carry
 * green or red. The legend shows the bucket under the crosshair (the latest
 * one otherwise) with its change as a signed, arrowed percent.
 *
 * The chart is created once and fed new data in place, so the 15 second
 * refresh never flickers or resets a view the trader has dragged. The view
 * resets only when `resetKey` (pool and interval) changes.
 */
export function PoolChart({ candles, interval, unit, quoteSymbol, resetKey, loading = false }: {
  candles: PoolCandle[];
  interval: ChartInterval;
  /** "QOR per QWAKK", for the accessible name. */
  unit: string;
  /** Volume is counted in the quote token. */
  quoteSymbol: string;
  resetKey: string;
  /** Another interval is on its way: the current one dims until it lands. */
  loading?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const shownKey = useRef("");
  const [hovered, setHovered] = useState<ChartBar | null>(null);

  // A new bucket opens every interval, so "now" moves with each refresh.
  const slots = useMemo(() => buildChartSlots(candles, interval), [candles, interval]);
  const bars = useMemo(() => slots.filter(isChartBar), [slots]);
  const decimals = useMemo(() => chartPriceDecimals(bars.flatMap((bar) => [bar.low, bar.high])), [bars]);
  const hasVolume = bars.some((bar) => bar.traded && bar.volume !== null && bar.volume > 0);
  const byTime = useMemo(() => new Map(bars.map((bar) => [bar.time, bar])), [bars]);
  const byTimeRef = useRef(byTime);
  useEffect(() => { byTimeRef.current = byTime; }, [byTime]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = createPoolChart(element);
    const price = instance.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderVisible: false,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
      // The current price is the brand's line, not a gain or a loss.
      priceLineColor: THEME.accent,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1,
      // Keep at least a 2% range, centred, so a quiet pool's near-flat path sits mid-chart.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (!info?.priceRange) return info;
        const { minValue, maxValue } = info.priceRange;
        const middle = (minValue + maxValue) / 2;
        const half = Math.max((maxValue - minValue) / 2, Math.abs(middle) * CHART_MIN_SPAN / 2);
        return { ...info, priceRange: { minValue: middle - half, maxValue: middle + half } };
      },
    });
    const volume = instance.addSeries(HistogramSeries, {
      color: THEME.volume,
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    instance.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    instance.subscribeCrosshairMove((param) => {
      const bar = param.time === undefined ? undefined : byTimeRef.current.get(Number(param.time));
      setHovered(param.point && bar ? bar : null);
    });
    chart.current = instance;
    priceSeries.current = price;
    volumeSeries.current = volume;
    return () => {
      instance.remove();
      chart.current = null;
      priceSeries.current = null;
      volumeSeries.current = null;
      shownKey.current = "";
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    const price = priceSeries.current;
    const volume = volumeSeries.current;
    const element = container.current;
    if (!instance || !price || !volume || !element) return;
    price.applyOptions({ priceFormat: { type: "custom", formatter: (value: number) => formatChartPrice(value, decimals), minMove: 10 ** -decimals } });
    instance.applyOptions(chartTimeOptions(interval === "1d"));
    instance.priceScale("right").applyOptions({ scaleMargins: hasVolume ? { top: 0.2, bottom: 0.24 } : { top: 0.2, bottom: 0.1 } });
    price.setData(slots.map((slot) => isChartBar(slot)
      ? { time: slot.time as UTCTimestamp, open: slot.open, high: slot.high, low: slot.low, close: slot.close, ...(slot.traded ? {} : { color: THEME.idle, wickColor: THEME.idle }) }
      : { time: slot.time as UTCTimestamp }));
    volume.setData(slots.map((slot) => isChartBar(slot) && slot.traded && slot.volume !== null && slot.volume > 0
      ? { time: slot.time as UTCTimestamp, value: slot.volume }
      : { time: slot.time as UTCTimestamp }));
    if (shownKey.current !== resetKey && slots.length > 0) {
      shownKey.current = resetKey;
      // The latest buckets, as many as fit at a readable width (at least CHART_MIN_SLOTS, padded in buildChartSlots).
      const fit = Math.max(1, Math.floor((element.clientWidth - PRICE_AXIS_PX) / MIN_BAR_PX));
      const visible = Math.min(slots.length, fit);
      instance.timeScale().setVisibleLogicalRange({ from: slots.length - visible - 0.5, to: slots.length - 1 + 3 });
    }
  }, [slots, decimals, hasVolume, interval, resetKey]);

  const latest = bars[bars.length - 1] ?? null;
  const shown = hovered ?? latest;
  const step = CHART_INTERVAL_SECONDS[interval];
  return <div className={`pool-chart ${loading ? "is-dimmed" : ""}`} aria-busy={loading || undefined}>
    <div ref={container} className="pool-chart-canvas" role="img" aria-label={`Pool price chart, ${unit}`} />
    {shown && <ChartLegend bar={shown} decimals={decimals} quoteSymbol={quoteSymbol} time={step >= 86_400 ? legendDay.format(shown.time * 1000) : legendTime.format(shown.time * 1000)} />}
  </div>;
}

function createPoolChart(element: HTMLElement) {
  return createChart(element, {
    ...chartBaseOptions(element),
    // Wheel scrolling stays with the page, and a vertical swipe on a phone scrolls the page, not the chart.
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: { time: true, price: true } },
  });
}

/** OHLC of one bucket, its change and volume. A quiet bucket says so instead of repeating one price four times. */
function ChartLegend({ bar, decimals, quoteSymbol, time }: { bar: ChartBar; decimals: number; quoteSymbol: string; time: string }) {
  const change = bar.open > 0 ? ((bar.close - bar.open) / bar.open) * 100 : null;
  const direction = change === null || Math.abs(change) < 0.005 ? "flat" : change > 0 ? "up" : "down";
  const price = (value: number) => formatChartPrice(value, decimals);
  return <div className="chart-legend" aria-hidden="true">
    <span className="chart-legend-time">{time}</span>
    {bar.traded
      ? <span className="chart-legend-row">
        <span className="chart-legend-ohl"><i>O</i>{price(bar.open)}</span>
        <span className="chart-legend-ohl"><i>H</i>{price(bar.high)}</span>
        <span className="chart-legend-ohl"><i>L</i>{price(bar.low)}</span>
        <span><i>C</i>{price(bar.close)}</span>
        {change !== null && <b className={`chart-legend-change is-${direction}`}>{direction === "flat" ? "0.00%" : `${direction === "up" ? "▲ +" : "▼ "}${change.toFixed(2)}%`}</b>}
      </span>
      : <span className="chart-legend-row"><span><i>C</i>{price(bar.close)}</span><span className="chart-legend-quiet">No trades</span></span>}
    {bar.traded && bar.volume !== null && bar.volume > 0 && <span className="chart-legend-row"><span><i>Vol</i>{formatChartVolume(bar.volume)} {quoteSymbol}</span></span>}
  </div>;
}

/** What the chart area says when there is no chart to draw, at the chart's own height so the panel never jumps. */
export function ChartMessage({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return <div className={`chart-empty pool-chart ${loading ? "is-loading" : ""}`} role={loading ? "status" : undefined}>
    <span className="empty-icon" aria-hidden="true"><ChartCandlestick size={18} /></span>
    <span>{children}</span>
  </div>;
}
