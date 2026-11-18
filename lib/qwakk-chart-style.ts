import { ColorType, CrosshairMode, LineStyle, TickMarkType, type DeepPartial, type Time, type TimeChartOptions } from "lightweight-charts";
import { THEME } from "./theme";

/**
 * The look every Qwakk price chart shares (browser only). Canvas text cannot
 * resolve CSS variables, so the mono font is read from the page once the
 * chart mounts; a "var(...)" font string would silently fall back to 10px
 * sans-serif.
 */
export function chartFont(element: HTMLElement) {
  const family = getComputedStyle(element).getPropertyValue("--font-mono").trim();
  return family || "ui-monospace, SFMono-Regular, monospace";
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function seconds(time: Time) {
  return typeof time === "number" ? time : typeof time === "string" ? Date.parse(time) / 1000 : Date.UTC(time.year, time.month - 1, time.day) / 1000;
}

/**
 * Axis and crosshair time labels. Intraday buckets read in the viewer's own
 * time zone (as the swaps table does); day buckets are UTC days, so their
 * dates stay in UTC and never slip to the day before west of Greenwich.
 */
export function chartTimeOptions(daily: boolean): Pick<DeepPartial<TimeChartOptions>, "localization" | "timeScale"> {
  const zone = daily ? "UTC" : undefined;
  const year = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: zone });
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: zone });
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone });
  const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
  const full = new Intl.DateTimeFormat("en-US", daily
    ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return {
    localization: { locale: "en-US", timeFormatter: (time: Time) => full.format(seconds(time) * 1000) },
    timeScale: {
      timeVisible: !daily,
      secondsVisible: false,
      tickMarkFormatter: (time: Time, type: TickMarkType) => {
        const date = seconds(time) * 1000;
        if (type === TickMarkType.Year) return year.format(date);
        if (type === TickMarkType.Month) return month.format(date);
        if (type === TickMarkType.DayOfMonth) return day.format(date);
        return clock.format(date);
      },
    },
  };
}

/** Transparent background, hairline grid, quiet dashed crosshair with chips on the raised surface. */
export function chartBaseOptions(element: HTMLElement, daily = false): DeepPartial<TimeChartOptions> {
  const time = chartTimeOptions(daily);
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: THEME.text,
      fontFamily: chartFont(element),
      fontSize: 11,
      // The footer credits TradingView, which meets the library's attribution notice.
      attributionLogo: false,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: THEME.grid } },
    rightPriceScale: { borderVisible: false, entireTextOnly: true },
    localization: time.localization,
    timeScale: { borderVisible: false, rightOffset: 3, minBarSpacing: 0.5, ...time.timeScale },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: THEME.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: THEME.raised },
      horzLine: { color: THEME.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: THEME.raised },
    },
    kineticScroll: { touch: !prefersReducedMotion(), mouse: false },
  };
}
