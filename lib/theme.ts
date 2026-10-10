/**
 * Chart colors mirror the CSS tokens in app/globals.css. Canvas charts cannot
 * read CSS variables, so both places must change together. Chart backgrounds
 * are transparent so they sit on whichever surface holds them. Up and down are
 * never the only signal: every change also carries a sign and an arrow.
 */
export const THEME = {
  surface: "#111214",
  grid: "#1a1b1f",
  axis: "#2a2b30",
  text: "#a0a1a8",
  accent: "#ffd43b",
  accentWash: "rgba(255, 212, 59, 0.18)",
  accentClear: "rgba(255, 212, 59, 0)",
  up: "#4ade80",
  down: "#f87171",
} as const;
