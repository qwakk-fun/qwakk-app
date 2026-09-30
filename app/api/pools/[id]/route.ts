import { isChartInterval } from "../../../../lib/qora-chart";
import { indexerRequest } from "../../../../lib/qora-market";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) return json({ error: "Pool not found" }, 404);

  const interval = new URL(request.url).searchParams.get("interval") ?? "1m";
  if (!isChartInterval(interval)) return json({ error: "Choose a supported chart interval" }, 400);

  const result = await indexerRequest(`/pools/${id}?interval=${interval}`);
  if (result?.status === 404) return json({ error: "Pool not found" }, 404);
  if (!result?.data) return json({ error: "Pool data is temporarily unavailable" }, 503);
  return json(result.data);
}
