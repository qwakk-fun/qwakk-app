const INDEXER_URL = (process.env.QORA_INDEXER_URL ?? "http://localhost:4400").replace(/\/$/, "");

export async function indexerRead(path: string) {
  try {
    const response = await fetch(`${INDEXER_URL}${path}`, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return response.json() as Promise<unknown>;
  } catch {
    return null;
  }
}
