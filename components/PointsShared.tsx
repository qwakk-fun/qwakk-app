import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { POINTS_DISCLAIMER, POINTS_HERO } from "../lib/qwakk-points-copy";
import { pointsUpdatedLine } from "../lib/qwakk-points-display";
import type { QwakkPointsSeason } from "../lib/qwakk-points";

/** The no-value notice. Body text size on purpose: it is not fine print. */
export function PointsDisclaimer({ className = "" }: { className?: string }) {
  return <p className={`points-disclaimer ${className}`}><Info size={16} aria-hidden="true" /><span>{POINTS_DISCLAIMER}</span></p>;
}

/** "Season testnet-1 on QoreChain Diana · Updated 3 min ago", plus any extra parts. */
export function PointsSeasonLine({ season, now, extra }: { season: QwakkPointsSeason | null; now: number; extra?: ReactNode }) {
  if (!season) return null;
  const updated = pointsUpdatedLine(season.computedAt, now);
  return <div className="points-meta">
    <span>{POINTS_HERO.season(season.id)}</span>
    {updated && <><i aria-hidden="true">·</i><span>{updated}</span></>}
    {extra && <><i aria-hidden="true">·</i><span>{extra}</span></>}
  </div>;
}
