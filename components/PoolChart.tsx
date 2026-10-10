"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { THEME } from "../lib/theme";

export type PoolCandle = {
  start_time: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
};

export function PoolChart({ candles }: { candles: PoolCandle[] }) {
  const element = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = element.current;
    if (!container || candles.length === 0) return;
    const chart = createChart(container, {
      autoSize: true,
      height: 400,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: THEME.text, fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: THEME.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderColor: THEME.axis, timeVisible: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: THEME.up, downColor: THEME.down, borderVisible: false, wickUpColor: THEME.up, wickDownColor: THEME.down });
    series.setData(candles.map((candle) => ({
      time: Math.floor(new Date(candle.start_time).getTime() / 1000) as UTCTimestamp,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    })).filter((candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close)));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles]);

  if (candles.length === 0) {
    return <div className="chart-empty pool-chart">No swaps have been indexed for this pool yet.</div>;
  }
  return <div className="pool-chart" ref={element} aria-label="Pool price chart" />;
}
