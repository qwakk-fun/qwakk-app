import { indexerRequest } from "@/lib/qwakk-market";
import { readChainIdCheck } from "@/lib/qwakk-chain-guard";
import { evaluateHealth, indexerHealthInput, type HealthReport } from "@/lib/qwakk-health";
import { getQwakkNetwork, publicNetwork } from "@/lib/qwakk-network";

/** The health route is exempt from rate limiting, so the deep result is reused for 10 seconds to keep it from amplifying load on QoreChain. */
const DEEP_TTL_MS = 10_000;
let deep: { at: number; report: Promise<HealthReport> } | null = null;

function deepReport(): Promise<HealthReport> {
  const now = Date.now();
  if (deep && now - deep.at < DEEP_TTL_MS) return deep.report;
  const network = getQwakkNetwork();
  // The indexer answers 503 with its own status while starting or lagging, so the body is read whatever the status.
  const report = Promise.all([readChainIdCheck(network), indexerRequest("/health", { errorBody: true })])
    .then(([chain, indexer]) => evaluateHealth({
      chain,
      indexer: indexerHealthInput(indexer),
      maxIndexerLag: process.env.QWAKK_HEALTH_MAX_INDEXER_LAG,
    }));
  deep = { at: now, report };
  return report;
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Web health.
 *
 * - `/api/health?shallow=1`: the process answers, nothing else is called. For
 *   load balancer and container liveness pings, so a QoreChain or indexer
 *   outage never restarts the web container.
 * - `/api/health`: a real check. The configured RPC and REST endpoints answer
 *   with the configured chain id, and the indexer's `/health` says ok. A
 *   starting, lagging or stalled indexer (its 503) is reported as reachable
 *   with its own status, height and lag, not as unreachable. When it reports a
 *   height, the lag behind the chain is checked against
 *   `QWAKK_HEALTH_MAX_INDEXER_LAG` blocks (default 600). Returns 503 when any
 *   check fails. The result is reused for 10 seconds.
 */
export async function GET(request: Request) {
  const network = getQwakkNetwork();
  const url = new URL(request.url);
  if (url.searchParams.has("shallow")) {
    return json({ ok: true, service: "qwakk-web", mode: "shallow", network: publicNetwork(network) }, 200);
  }

  const health = await deepReport();
  return json({ service: "qwakk-web", mode: "deep", network: publicNetwork(network), ...health }, health.ok ? 200 : 503);
}
