import { indexerRead } from "../../../../lib/qora-market";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) {
    return Response.json({ error: "Pool not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const data = await indexerRead(`/pools/${id}`);
  if (!data) {
    return Response.json({ error: "Pool data is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
