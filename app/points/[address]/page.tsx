import { notFound } from "next/navigation";
import { PointsWalletView } from "../../../components/PointsWalletView";
import { POINTS_META } from "../../../lib/qwakk-points-copy";
import { shortPointsAddress } from "../../../lib/qwakk-points-display";
import { isPointsAddress, pointsEnabled } from "../../../lib/qwakk-points";

// The flag is read per request, so turning points on or off needs no rebuild.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ address: string }> };

function normalize(value: string) {
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    // A malformed escape is not an address; the view shows the invalid state.
    return "";
  }
}

export async function generateMetadata({ params }: Params) {
  const address = normalize((await params).address);
  return {
    title: isPointsAddress(address) ? POINTS_META.walletTitle(shortPointsAddress(address)) : POINTS_META.title,
    description: POINTS_META.walletDescription,
  };
}

/** Points detail for one wallet. A plain 404 while QWAKK_POINTS_ENABLED is off. */
export default async function PointsWalletPage({ params }: Params) {
  if (!pointsEnabled()) notFound();
  const address = normalize((await params).address);
  return <PointsWalletView key={address} address={address} />;
}
