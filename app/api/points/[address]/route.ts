import { indexerRequest } from "@/lib/qwakk-market";
import { isPointsAddress, pointsEnabled } from "@/lib/qwakk-points";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Points detail for one address. An address without points answers 200 with `ranked: false`. */
export async function GET(_request: Request, context: { params: Promise<{ address: string }> }) {
  if (!pointsEnabled()) return json({ error: "Not found" }, 404);
  const address = (await context.params).address.trim().toLowerCase();
  if (!isPointsAddress(address)) return json({ error: "A valid QoreChain address is required" }, 400);

  const result = await indexerRequest(`/points/addresses/${address}`);
  if (result?.status !== 200 || !result.data) return json({ error: "Points are temporarily unavailable" }, 503);
  return json(result.data);
}
