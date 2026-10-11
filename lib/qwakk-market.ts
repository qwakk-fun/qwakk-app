const INDEXER_URL = (process.env.QWAKK_INDEXER_URL ?? "http://localhost:4400").replace(/\/$/, "");

/** Reads the indexer and keeps its HTTP status, so a missing pool is not reported as an outage. */
export async function indexerRequest(path: string): Promise<{ status: number; data: unknown } | null> {
  try {
    const response = await fetch(`${INDEXER_URL}${path}`, { cache: "no-store", headers: { Accept: "application/json" } });
    return { status: response.status, data: response.ok ? await response.json() as unknown : null };
  } catch {
    return null;
  }
}

export async function indexerRead(path: string) {
  const result = await indexerRequest(path);
  return result && result.status >= 200 && result.status < 300 ? result.data : null;
}
