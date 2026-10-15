import { POINTS_UPDATED } from "./qwakk-points-copy";

/**
 * Display helpers for the points pages. Points and QOR figures arrive as exact
 * decimal strings, so they are formatted as strings: no float ever touches a
 * number the user reads.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Groups thousands and cuts the fraction to `maxFraction` places (truncated,
 * never rounded up, so a score is never shown higher than it is). Anything
 * that is not a plain non-negative decimal shows as "0".
 */
export function formatPointsDecimal(value: string | number | null | undefined, maxFraction = 2) {
  const text = typeof value === "number" ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : "") : (value ?? "").trim();
  const match = DECIMAL.exec(text);
  if (!match) return "0";
  const whole = match[1].replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (match[2] ?? "").slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Whole counts (ranks, wallets, days) with grouped thousands. */
export function formatCount(value: number) {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value) : "0";
}

/** A wallet address cut to its start and end, matching the rest of the app. */
export function shortPointsAddress(address: string) {
  return address.length > 16 ? `${address.slice(0, 9)}…${address.slice(-6)}` : address;
}

/**
 * The "updated" line under the hero. `now` is 0 before the page mounts, so
 * server and first client render agree and show nothing.
 */
export function pointsUpdatedLine(computedAt: string | null, now: number) {
  if (computedAt === null) return POINTS_UPDATED.pending;
  if (!now) return "";
  const time = new Date(computedAt).getTime();
  if (!Number.isFinite(time)) return POINTS_UPDATED.pending;
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes >= 60) return POINTS_UPDATED.hours;
  if (minutes < 1) return POINTS_UPDATED.now;
  if (minutes === 1) return POINTS_UPDATED.one;
  return POINTS_UPDATED.many(minutes);
}

/** A share of the total in percent, for bar widths only (never shown as a number). */
export function pointsShare(part: string, total: string) {
  const a = Number(part);
  const b = Number(total);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0 || a <= 0) return 0;
  return Math.min(100, (a / b) * 100);
}

/** "2026-10-14" as "Oct 14, 2026", read as a UTC day. */
export function formatPointsDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}
