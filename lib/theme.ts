/**
 * Chart colors mirror the CSS tokens in app/globals.css. Canvas charts cannot
 * read CSS variables, so both places must change together. Chart backgrounds
 * are transparent so they sit on whichever surface holds them. Up and down are
 * never the only signal: every change also carries a sign and an arrow.
 */
export const THEME = {
  surface: "#111214",
  /** Crosshair label chips sit on the raised surface (--raised), not the library's default blue-gray. */
  raised: "#17181b",
  /** Hairline grid on the raised tone, so it reads as structure and never competes with the series. */
  grid: "#17181b",
  axis: "#2a2b30",
  text: "#a0a1a8",
  /** Crosshair guides on --text-3: visible on the panel, quieter than the series. */
  crosshair: "#6c6d74",
  /** A bucket with no trades, drawn flat at the last price: --text-3 at 55%, so it reads as "no move", never as a gain or loss. */
  idle: "rgba(108, 109, 116, 0.55)",
  /** Volume bars: --text-2 at 22%. Neutral, because volume is not a gain or a loss. */
  volume: "rgba(160, 161, 168, 0.22)",
  accent: "#ffd43b",
  accentWash: "rgba(255, 212, 59, 0.18)",
  accentClear: "rgba(255, 212, 59, 0)",
  up: "#4ade80",
  down: "#f87171",
} as const;
