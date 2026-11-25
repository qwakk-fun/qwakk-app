import { indexerRequest } from "@/lib/qwakk-market";
import { rewardsEnabled } from "@/lib/qwakk-rewards";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Rewards programs with the running epoch and the finalized epochs. */
export async function GET() {
  if (!rewardsEnabled()) return json({ error: "Not found" }, 404);
  const result = await indexerRequest("/rewards/programs");
  const data = result?.status === 200 ? result.data as { programs?: unknown } | null : null;
  if (!data || !Array.isArray(data.programs)) return json({ error: "Rewards are temporarily unavailable" }, 503);
  return json(data);
}
