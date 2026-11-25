import { nativeActionSwitches } from "@/lib/features";
import { rewardsClaimContract } from "@/lib/qwakk-native-rewards";
import { pointsEnabled } from "@/lib/qwakk-points";
import { rewardsEnabled } from "@/lib/qwakk-rewards";
import { getQwakkNetwork, publicNetwork } from "@/lib/qwakk-network";

/**
 * Feature switches the browser needs before it renders wallet actions or the
 * points pages, plus the network it must ask QoreX for. `nativeActions` stays
 * for existing callers: true when any action is on. `rewards_claim` is on
 * only when a rewards contract is configured for this network as well.
 * `rewards` is QWAKK_REWARDS_ENABLED: the rewards pages need it and
 * `rewards_claim` both before they render anything.
 */
export async function GET() {
  const network = getQwakkNetwork();
  const switches = nativeActionSwitches();
  const actions = { ...switches, rewards_claim: switches.rewards_claim && rewardsClaimContract(process.env, network.id) !== null };
  return Response.json(
    {
      nativeActions: Object.values(actions).some(Boolean),
      actions,
      points: pointsEnabled(),
      rewards: rewardsEnabled(),
      network: publicNetwork(network),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
