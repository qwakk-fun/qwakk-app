import { indexerRequest } from "@/lib/qwakk-market";
import { isRewardsAddress, rewardsEnabled } from "@/lib/qwakk-rewards";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** An address's claimable allocations with proofs, and its estimate for the running epoch. */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  if (!rewardsEnabled()) return json({ error: "Not found" }, 404);
  const address = (await context.params).address.trim().toLowerCase();
  if (!isRewardsAddress(address)) return json({ error: "A valid QoreChain address is required" }, 400);

  const result = await indexerRequest(`/rewards/addresses/${address}`);
  const data = result?.status === 200 ? result.data as { claims?: unknown } | null : null;
  if (!data || !Array.isArray(data.claims)) return json({ error: "Rewards are temporarily unavailable" }, 503);
  return json(data);
}
