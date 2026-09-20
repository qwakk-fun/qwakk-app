import { indexerRead } from "@/lib/qora-market";

const TESTNET_RPC = (process.env.QORECHAIN_RPC_URL ?? "https://rpc-testnet.qore.host").replace(/\/$/, "");

export async function GET() {
  const [diana, indexer] = await Promise.all([
    fetch(`${TESTNET_RPC}/status`, { cache: "no-store", signal: AbortSignal.timeout(5_000) })
      .then((response) => response.ok)
      .catch(() => false),
    indexerRead("/health").then((response) => response !== null),
  ]);

  return Response.json(
    { ok: true, service: "qora-web", network: "qorechain-diana", dependencies: { diana, indexer } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
