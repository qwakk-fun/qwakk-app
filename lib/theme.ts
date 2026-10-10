/**
 * Chart colors mirror the CSS tokens in app/globals.css. Canvas charts cannot
 * read CSS variables, so both places must change together. Up and down are
 * never the only signal: every change also carries a sign and an arrow.
 */
export const THEME = {
  surface: "#111113",
  grid: "#1c1d20",
  axis: "#2c2e33",
  text: "#a1a1aa",
  accent: "#86efac",
  accentWash: "rgba(134, 239, 172, 0.18)",
  accentClear: "rgba(134, 239, 172, 0)",
  up: "#4ade80",
  down: "#f87171",
} as const;
