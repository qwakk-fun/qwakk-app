import { nativeActionsEnabled } from "@/lib/features";
import { pointsEnabled } from "@/lib/qwakk-points";

/** Feature switches the browser needs before it renders wallet actions or the points pages. */
export async function GET() {
  return Response.json({ nativeActions: nativeActionsEnabled(), points: pointsEnabled() }, { headers: { "Cache-Control": "no-store" } });
}
