import { nativeActionsEnabled } from "@/lib/features";

/** Feature switches the browser needs before it renders wallet actions. */
export async function GET() {
  return Response.json({ nativeActions: nativeActionsEnabled() }, { headers: { "Cache-Control": "no-store" } });
}
