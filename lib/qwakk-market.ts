const INDEXER_URL = (process.env.QWAKK_INDEXER_URL ?? "http://localhost:4400").replace(/\/$/, "");
/** The indexer is on the private network; a read slower than this is treated as unavailable. */
const INDEXER_TIMEOUT_MS = 5_000;

/**
 * Reads the indexer and keeps its HTTP status, so a missing pool is not
 * reported as an outage. Null only when the indexer did not answer at all.
 * `errorBody` also parses a non-2xx JSON body (the indexer's `/health` answers
 * 503 with its status while starting, lagging or stalled); otherwise `data` is
 * null for a non-2xx answer.
 */
export async function indexerRequest(path: string, options: { errorBody?: boolean } = {}): Promise<{ status: number; data: unknown } | null> {
  let response: Response;
  try {
    response = await fetch(`${INDEXER_URL}${path}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok && !options.errorBody) return { status: response.status, data: null };
  try {
    return { status: response.status, data: await response.json() as unknown };
  } catch {
    // A 2xx with an unreadable body is treated as no answer, as before; an error status is still an answer.
    return response.ok ? null : { status: response.status, data: null };
  }
}

export async function indexerRead(path: string) {
  const result = await indexerRequest(path);
  return result && result.status >= 200 && result.status < 300 ? result.data : null;
}
