import { notFound } from "next/navigation";
import { PointsView } from "../../components/PointsView";
import { POINTS_META } from "../../lib/qwakk-points-copy";
import { pointsEnabled } from "../../lib/qwakk-points";

// The flag is read per request, so turning points on or off needs no rebuild.
export const dynamic = "force-dynamic";

export const metadata = {
  title: POINTS_META.title,
  description: POINTS_META.description,
};

/** Testnet points leaderboard. A plain 404 while QWAKK_POINTS_ENABLED is off. */
export default function PointsPage() {
  if (!pointsEnabled()) notFound();
  return <PointsView />;
}
