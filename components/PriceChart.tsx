"use client";

import { useEffect, useRef } from "react";
import { AreaSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { formatUsdPrice, type MarketPoint } from "../lib/qor-price";
import { THEME } from "../lib/theme";

const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Single-series QOR/USD area chart. The title outside names the series, so no
 * legend box. A vertical crosshair snaps to the nearest point and the tooltip
 * leads with the value.
 */
export function PriceChart({ points, dimmed = false, height = 360 }: { points: MarketPoint[]; dimmed?: boolean; height?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const instance = createChart(element, {
      autoSize: true,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: THEME.text, fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: THEME.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: THEME.axis, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: THEME.axis, width: 1, style: LineStyle.Solid, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    const area = instance.addSeries(AreaSeries, {
      lineColor: THEME.accent,
      lineWidth: 2,
      topColor: THEME.accentWash,
      bottomColor: THEME.accentClear,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: THEME.surface,
      crosshairMarkerBorderWidth: 2,
      priceFormat: { type: "custom", formatter: (value: number) => formatUsdPrice(value), minMove: 0.000001 },
    });

    instance.subscribeCrosshairMove((param) => {
      const box = tooltip.current;
      if (!box) return;
      const point = param.seriesData.get(area) as { value?: number } | undefined;
      if (!param.point || param.time === undefined || point?.value === undefined) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      // textContent only: values come from an external API.
      box.children[0].textContent = formatUsdPrice(point.value);
      box.children[1].textContent = dateTime.format(new Date(Number(param.time) * 1000));
      const left = Math.min(Math.max(param.point.x + 14, 8), element.clientWidth - box.offsetWidth - 8);
      box.style.transform = `translate(${left}px, 12px)`;
    });

    chart.current = instance;
    series.current = area;
    return () => {
      instance.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    series.current.setData(points.map((point) => ({ time: point.time as UTCTimestamp, value: point.price })));
    chart.current.timeScale().fitContent();
  }, [points]);

  return <div className={`price-chart ${dimmed ? "is-dimmed" : ""}`} style={{ height }}>
    <div ref={container} className="price-chart-canvas" aria-label="QOR price in US dollars" role="img" />
    <div ref={tooltip} className="chart-tooltip" hidden><strong /><span /></div>
  </div>;
}
