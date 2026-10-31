/**
 * A tiny in-process cache for server routes that relay QoreChain or indexer
 * reads. Concurrent callers for the same key share one upstream request, and a
 * result is reused for a few seconds, so many clients polling the same route
 * cost one upstream call per TTL instead of one per request.
 *
 * Loaders must not throw: return a failure value and give it a short TTL.
 */
export function createServerCache<T>(options: { ttlMs: (value: T) => number; maxEntries?: number }) {
  const store = new Map<string, { expires: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  const maxEntries = Math.max(1, options.maxEntries ?? 1_000);

  return function read(key: string, load: () => Promise<T>): Promise<T> {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        const ttl = options.ttlMs(value);
        store.delete(key);
        if (ttl > 0) {
          store.set(key, { expires: Date.now() + ttl, value });
          while (store.size > maxEntries) {
            const oldest = store.keys().next().value;
            if (oldest === undefined) break;
            store.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}

/** A route result kept in the cache: rebuilt into a fresh Response per caller. */
export type CachedJson = { status: number; body: unknown };

export function cachedJsonResponse(result: CachedJson) {
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
