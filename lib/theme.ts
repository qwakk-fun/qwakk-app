/**
 * Chart colors mirror the CSS tokens in app/globals.css. Canvas charts cannot
 * read CSS variables, so both places must change together. Up and down were
 * validated for colorblind separation on the panel surface, and every change
 * also carries a sign and an arrow.
 */
export const THEME = {
  surface: "#0c0f13",
  grid: "#161b21",
  axis: "#232a32",
  text: "#9aa3ad",
  accent: "#8f7cff",
  accentWash: "rgba(143, 124, 255, 0.10)",
  up: "#12a8a0",
  down: "#f05a3c",
} as const;
