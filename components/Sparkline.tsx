import type { MarketPoint } from "../lib/qor-price";

/**
 * A trend line for stat tiles and watchlist rows. It has no axis or hover; the
 * tile states the value. `minSpan` (a share of the price, 0.02 for 2%) keeps a
 * nearly flat line flat instead of stretching it edge to edge.
 */
export function Sparkline({ points, width = 220, height = 56, minSpan = 0 }: { points: MarketPoint[]; width?: number; height?: number; minSpan?: number }) {
  if (points.length < 2) return <svg className="sparkline" width={width} height={height} aria-hidden="true" />;
  const prices = points.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const spread = Math.max(high - low, Math.abs((high + low) / 2) * minSpan) || 1;
  const min = (high + low) / 2 - spread / 2;
  const step = width / (points.length - 1);
  const y = (value: number) => 4 + (height - 8) * (1 - (value - min) / spread);
  const line = points.map((point, index) => `${index ? "L" : "M"}${(index * step).toFixed(2)},${y(point.price).toFixed(2)}`).join(" ");

  return <svg className="sparkline" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={`${line} L${width},${height} L0,${height} Z`} className="sparkline-area" />
    <path d={line} className="sparkline-line" vectorEffect="non-scaling-stroke" />
  </svg>;
}
