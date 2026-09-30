export const MARKET_RANGES = ["1", "7", "30", "90"] as const;
export type MarketRange = (typeof MARKET_RANGES)[number];

export const MARKET_RANGE_LABELS: Record<MarketRange, string> = { "1": "24H", "7": "7D", "30": "30D", "90": "90D" };

export type MarketPoint = { time: number; price: number };

export type QorMarket = {
  price: number;
  change24h: number | null;
  volume24h: number | null;
  marketCap: number | null;
  range: MarketRange;
  points: MarketPoint[];
  updatedAt: number;
};

export function isMarketRange(value: string): value is MarketRange {
  return (MARKET_RANGES as readonly string[]).includes(value);
}

const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

/** QOR trades well below one dollar, so small prices keep enough significant digits. */
export function formatUsdPrice(value: number) {
  if (!Number.isFinite(value)) return "Not available";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatUsdCompact(value: number | null) {
  return value === null || !Number.isFinite(value) ? "Not available" : usdCompact.format(value);
}

export function formatChange(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "Not available";
  return `${value >= 0 ? "▲" : "▼"} ${Math.abs(value).toFixed(2)}%`;
}
