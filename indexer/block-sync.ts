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

/**
 * Where indexing can resume when the node prunes old blocks. A saved height
 * below the node's earliest kept block can never be read again (the RPC
 * answers "height N is not available"), so the indexer would retry it
 * forever. The node's own status is a positive answer that those blocks are
 * gone, so the gap is reported and indexing resumes at the earliest kept block.
 */
export function resumeAfterPruning(savedHeight: number, earliestHeight: number) {
  if (!Number.isSafeInteger(earliestHeight) || earliestHeight <= 1 || savedHeight + 1 >= earliestHeight) {
    return { savedHeight, skipped: null };
  }
  return { savedHeight: earliestHeight - 1, skipped: { from: savedHeight + 1, to: earliestHeight - 1 } };
}

/** Blocks behind the tip before the indexer switches from block scanning to an event search. */
export const CATCH_UP_THRESHOLD = 300;
/** Blocks covered by one event search. */
export const CATCH_UP_SPAN = 20_000;
/** The newest blocks are always scanned one by one, in case the node's tx index lags its blocks. */
export const CATCH_UP_MARGIN = 100;

/** The range to catch up through an event search, or null when block scanning is enough. */
export function catchUpRange(savedHeight: number, currentHeight: number) {
  if (currentHeight - savedHeight <= CATCH_UP_THRESHOLD) return null;
  const to = Math.min(savedHeight + CATCH_UP_SPAN, currentHeight - CATCH_UP_MARGIN);
  return to > savedHeight ? { from: savedHeight + 1, to } : null;
}

export type CatchUpHandlers = BlockRangeHandlers & {
  /** Heights in [from, to] that hold AMM events. Throws when the search is unavailable. */
  findHeights: (from: number, to: number) => Promise<number[]>;
};

/**
 * Indexes only the blocks an event search found in [from, to], through the
 * same block path as scanning, then marks the whole range as indexed. A
 * failing block stops before its height (and the range end) is saved.
 */
export async function catchUpWithSearch(from: number, to: number, handlers: CatchUpHandlers) {
  const heights = [...new Set(await handlers.findHeights(from, to))]
    .filter((height) => Number.isSafeInteger(height) && height >= from && height <= to)
    .sort((a, b) => a - b);
  for (const height of heights) {
    await handlers.processBlock(height);
    await handlers.saveHeight(height);
  }
  await handlers.saveHeight(to);
  return heights.length;
}

/**
 * True when the event search finds a block we already know holds an AMM
 * event. A node whose tx index does not cover amm_* events answers every
 * search with zero results; trusting it would mark whole spans as indexed and
 * skip their events forever. Search failures propagate to the caller.
 */
export async function verifyEventSearch(referenceHeight: number | null, findHeights: (from: number, to: number) => Promise<number[]>) {
  if (referenceHeight === null || !Number.isSafeInteger(referenceHeight) || referenceHeight <= 0) return false;
  return (await findHeights(referenceHeight, referenceHeight)).includes(referenceHeight);
}
