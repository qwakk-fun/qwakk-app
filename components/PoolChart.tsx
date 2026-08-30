"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";

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
      layout: { background: { type: ColorType.Solid, color: "#091310" }, textColor: "#8d9b94", fontFamily: "var(--font-geist-sans), Arial, sans-serif" },
      grid: { vertLines: { color: "rgba(218, 239, 225, 0.06)" }, horzLines: { color: "rgba(218, 239, 225, 0.06)" } },
      rightPriceScale: { borderColor: "rgba(218, 239, 225, 0.12)" },
      timeScale: { borderColor: "rgba(218, 239, 225, 0.12)", timeVisible: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: "#53e5c0", downColor: "#f06b72", borderVisible: false, wickUpColor: "#53e5c0", wickDownColor: "#f06b72" });
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
    return <div className="terminal-empty chart-empty"><span className="status-dot" />No swaps have been indexed for this pool yet.</div>;
  }
  return <div className="pool-chart" ref={element} aria-label="Pool price chart" />;
}
