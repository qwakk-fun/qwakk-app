/**
 * Block path rules shared by the indexer and its tests.
 *
 * A block is only marked as indexed after every event in it was stored. Any
 * transient failure (network, gateway 5xx, database) must throw, so the same
 * block is retried on the next tick and nothing is skipped. Only a positive
 * "does not exist" answer from the chain may lead to an event being dropped.
 */

/** gRPC status code NOT_FOUND, as the Cosmos gateway puts it in an error body. */
const GRPC_NOT_FOUND = 5;

/**
 * True when a QoreChain REST answer positively says the resource does not
 * exist: HTTP 404, or a gateway error body carrying gRPC NOT_FOUND.
 */
export function isNotFoundAnswer(status: number, body: unknown) {
  if (status === 404) return true;
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return status >= 400 && Number(code) === GRPC_NOT_FOUND;
}

export type ChainLookup<T> = { status: "found"; value: T } | { status: "missing" };

export type PoolStore<T> = {
  isStored: (poolId: string) => Promise<boolean>;
  /** Throws on transient failures; returns missing only on a positive not-found answer. */
  fetchPool: (poolId: string) => Promise<ChainLookup<T>>;
  persist: (pool: T) => Promise<void>;
};

/**
 * Makes sure a pool referenced by an event is stored. Returns false only when
 * the chain says the pool does not exist (or returned a pool that cannot be
 * stored). Fetch and database errors propagate to the caller.
 */
export async function ensurePoolStored<T>(poolId: string, store: PoolStore<T>) {
  if (await store.isStored(poolId)) return true;
  const lookup = await store.fetchPool(poolId);
  if (lookup.status === "missing") return false;
  await store.persist(lookup.value);
  return store.isStored(poolId);
}

export type BlockRangeHandlers = {
  processBlock: (height: number) => Promise<void>;
  saveHeight: (height: number) => Promise<void>;
};

/**
 * Indexes blocks after `savedHeight` up to `until`, saving progress after each
 * one. A failing block stops the range before its height is saved.
 */
export async function indexBlockRange(savedHeight: number, until: number, handlers: BlockRangeHandlers) {
  for (let height = savedHeight + 1; height <= until; height += 1) {
    await handlers.processBlock(height);
    await handlers.saveHeight(height);
  }
}
