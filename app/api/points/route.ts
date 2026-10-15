import { indexerRequest } from "@/lib/qwakk-market";
import { QWAKK_POINTS_MAX_PAGE_SIZE, QWAKK_POINTS_PAGE_SIZE, pointsEnabled } from "@/lib/qwakk-points";

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function positiveInteger(value: string | null, fallback: number, max: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  return Math.min(max, Math.max(1, Number(value)));
}

type IndexerLeaderboard = { season?: unknown; entries?: unknown[]; pagination?: { total?: number } };

/** Points leaderboard, ranked by total points. `page` starts at 1. */
export async function GET(request: Request) {
  if (!pointsEnabled()) return json({ error: "Not found" }, 404);
  const params = new URL(request.url).searchParams;
  const pageSize = positiveInteger(params.get("pageSize"), QWAKK_POINTS_PAGE_SIZE, QWAKK_POINTS_MAX_PAGE_SIZE);
  const page = positiveInteger(params.get("page"), 1, 10_000);

  const result = await indexerRequest(`/points/leaderboard?limit=${pageSize}&offset=${(page - 1) * pageSize}`);
  const data = result?.status === 200 ? result.data as IndexerLeaderboard | null : null;
  if (!data || !Array.isArray(data.entries)) return json({ error: "Points are temporarily unavailable" }, 503);
  const total = Number(data.pagination?.total) || 0;
  return json({
    season: data.season,
    entries: data.entries,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  });
}
