import { QORECHAIN_RPC_URL } from "@/lib/qorechain-endpoints";
import { indexerRead } from "@/lib/qora-market";

export async function GET() {
  const [diana, indexer] = await Promise.all([
    fetch(`${QORECHAIN_RPC_URL}/status`, { cache: "no-store", signal: AbortSignal.timeout(5_000) })
      .then((response) => response.ok)
      .catch(() => false),
    indexerRead("/health").then((response) => response !== null),
  ]);

  return Response.json(
    { ok: true, service: "qora-web", network: "qorechain-diana", dependencies: { diana, indexer } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
