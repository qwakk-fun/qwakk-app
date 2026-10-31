import { nativeActionSwitches } from "@/lib/features";
import { pointsEnabled } from "@/lib/qwakk-points";
import { getQwakkNetwork, publicNetwork } from "@/lib/qwakk-network";

/**
 * Feature switches the browser needs before it renders wallet actions or the
 * points pages, plus the network it must ask QoreX for. `nativeActions` stays
 * for existing callers: true when any action is on.
 */
export async function GET() {
  const actions = nativeActionSwitches();
  return Response.json(
    {
      nativeActions: Object.values(actions).some(Boolean),
      actions,
      points: pointsEnabled(),
      network: publicNetwork(getQwakkNetwork()),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
