"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { formatQuotePrice } from "../lib/qwakk-market-view";
import { THEME } from "../lib/theme";

/** One `quote_candles` bucket from `/api/pools/:id`: prices in quote per base, volume in the quote token. */
export type PoolCandle = {
  start_time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume?: string | number | null;
};

/** A price step fine enough for the smallest price on screen, so tiny prices do not round to 0. */
function minMoveFor(values: number[]) {
  const smallest = Math.min(...values.filter((value) => value > 0));
  if (!Number.isFinite(smallest)) return 0.000001;
  return Math.max(1e-15, Math.min(0.01, 10 ** (Math.floor(Math.log10(smallest)) - 4)));
}

export function PoolChart({ candles, unit }: { candles: PoolCandle[]; unit: string }) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = element.current;
    if (!container || candles.length === 0) return;
    const data = candles.map((candle) => ({
      time: Math.floor(new Date(candle.start_time).getTime() / 1000) as UTCTimestamp,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    })).filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close));
    const chart = createChart(container, {
      autoSize: true,
      height: 400,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: THEME.text, fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: THEME.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderColor: THEME.axis, timeVisible: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderVisible: false,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
      priceFormat: { type: "custom", formatter: (value: number) => formatQuotePrice(value), minMove: minMoveFor(data.map((candle) => candle.low)) },
    });
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles]);

  if (candles.length === 0) {
    return <div className="chart-empty pool-chart">No swaps have been indexed for this pool yet.</div>;
  }
  return <div className="pool-chart" ref={element} role="img" aria-label={`Pool price chart, ${unit}`} />;
}
