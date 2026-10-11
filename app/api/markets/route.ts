import { indexerRead } from "../../../lib/qwakk-market";

export async function GET() {
  const data = await indexerRead("/markets");
  if (!data) {
    return Response.json({ error: "Market data is temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
