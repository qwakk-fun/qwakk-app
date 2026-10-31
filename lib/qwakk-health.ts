import type { ChainIdCheck } from "@/lib/qwakk-chain-guard";

export const DEFAULT_MAX_INDEXER_LAG = 600;

/** The states the indexer's own `/health` reports (indexer/indexer-config.ts `evaluateIndexerHealth`). */
export const INDEXER_HEALTH_STATUSES = ["ok", "starting", "lagging", "stalled"] as const;
export type IndexerHealthStatus = (typeof INDEXER_HEALTH_STATUSES)[number];

/** What the web reads from the indexer's `/health`, whatever its HTTP status. */
export type IndexerHealthInput = {
  height: string | null;
  /** The HTTP status the indexer answered with: 200 when ok, 503 while starting, lagging or stalled. */
  httpStatus?: number;
  /** The indexer's own verdict, when its body carries one. */
  status?: IndexerHealthStatus | null;
  /** The lag the indexer reports behind its own view of the chain tip. */
  lag?: number | null;
};

export type HealthReport = {
  ok: boolean;
  checks: {
    chain: { ok: boolean; state: ChainIdCheck["state"]; height: string | null };
    indexer: {
      ok: boolean;
      /** The indexer answered (a 2xx, or an error status carrying its own health body). */
      reachable: boolean;
      httpStatus: number | null;
      /** The indexer's own status: "starting" and "lagging" mean reachable but not ready. */
      status: IndexerHealthStatus | null;
      height: string | null;
      /** Lag behind the web's chain height; the indexer's own lag when the chain height is unknown. */
      lag: number | null;
      /** The lag the indexer reported itself. */
      reportedLag: number | null;
      maxLag: number;
    };
  };
};

/** A block height from the indexer's `/health` body, when it reports one. */
export function indexerHeight(body: unknown): string | null {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  for (const key of ["height", "lastHeight", "last_height", "syncedHeight", "synced_height"]) {
    const value = record[key];
    const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text === "string" && /^\d+$/.test(text)) return text;
  }
  return null;
}

/**
 * Turns the indexer's `/health` answer into health input. Null when the
 * indexer did not answer, or when a non-2xx answer is not the indexer's own
 * health body (a proxy error page, for example), so that still reads as
 * unreachable.
 */
export function indexerHealthInput(answer: { status: number; data: unknown } | null): IndexerHealthInput | null {
  if (!answer) return null;
  const record = (answer.data && typeof answer.data === "object" ? answer.data : {}) as Record<string, unknown>;
  const status = INDEXER_HEALTH_STATUSES.find((value) => value === record.status) ?? null;
  const success = answer.status >= 200 && answer.status < 300;
  if (!success && status === null) return null;
  const lag = typeof record.lag === "number" && Number.isSafeInteger(record.lag) && record.lag >= 0 ? record.lag : null;
  return { height: indexerHeight(answer.data), httpStatus: answer.status, status, lag };
}

function maxLag(value: string | undefined) {
  const text = value?.trim() ?? "";
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : DEFAULT_MAX_INDEXER_LAG;
}

/**
 * Pure health verdict. Unhealthy when the chain is unreachable or serves
 * another chain id, when the indexer does not answer, when the indexer
 * answers that it is not ok (starting, lagging or stalled, HTTP 503), or when
 * it is more than `maxIndexerLag` blocks behind the chain. A starting or
 * lagging indexer is reported as reachable with its own status, height and
 * lag. The web computes the lag when both heights are known and falls back to
 * the indexer's own figure otherwise.
 */
export function evaluateHealth(input: { chain: ChainIdCheck; indexer: IndexerHealthInput | null; maxIndexerLag?: string }): HealthReport {
  const chainHeight = input.chain.state === "match" ? input.chain.height : null;
  const limit = maxLag(input.maxIndexerLag);
  const indexer = input.indexer;
  const indexerHeightValue = indexer?.height ?? null;
  const reportedLag = indexer?.lag ?? null;
  const lag = chainHeight !== null && indexerHeightValue !== null
    ? Math.max(0, Number(BigInt(chainHeight) - BigInt(indexerHeightValue)))
    : reportedLag;
  const httpStatus = indexer?.httpStatus ?? null;
  const answeredOk = httpStatus === null || (httpStatus >= 200 && httpStatus < 300);
  const chainOk = input.chain.state === "match";
  const indexerOk = indexer !== null && answeredOk && (lag === null || lag <= limit);
  return {
    ok: chainOk && indexerOk,
    checks: {
      chain: { ok: chainOk, state: input.chain.state, height: chainHeight },
      indexer: {
        ok: indexerOk,
        reachable: indexer !== null,
        httpStatus,
        status: indexer?.status ?? null,
        height: indexerHeightValue,
        lag,
        reportedLag,
        maxLag: limit,
      },
    },
  };
}
