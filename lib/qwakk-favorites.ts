/**
 * Favorite pools, kept in this browser only (no wallet, no server). Pool ids
 * belong to one network, so the list is stored per network:
 * `{"testnet":["6","1"]}` under `qwakk-favorite-pools`, newest first.
 *
 * Writes announce themselves with `FAVORITES_EVENT` so every star on the page
 * updates; other tabs hear the browser's own `storage` event for the same key.
 * Pure apart from the storage it is handed, so tests pass a stand-in.
 */

export const FAVORITES_KEY = "qwakk-favorite-pools";
export const FAVORITES_EVENT = "qwakk:favorites-change";
/** Plenty for a watchlist, and it keeps a bad write from growing the entry without end. */
export const MAX_FAVORITES = 100;

export type FavoritesByNetwork = Readonly<Record<string, readonly string[]>>;
type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

const POOL_ID = /^\d{1,20}$/;
const NETWORK_ID = /^[a-z0-9-]{1,32}$/;

/** Reads the stored value. Anything malformed is dropped, never thrown. */
export function parseFavorites(raw: string | null | undefined): FavoritesByNetwork {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const result: Record<string, string[]> = {};
  for (const [network, ids] of Object.entries(data as Record<string, unknown>)) {
    if (!NETWORK_ID.test(network) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.map((id) => typeof id === "number" ? String(id) : id).filter((id): id is string => typeof id === "string" && POOL_ID.test(id)))];
    if (clean.length) result[network] = clean.slice(0, MAX_FAVORITES);
  }
  return result;
}

/** The favorite pool ids for one network, newest first. */
export function favoritesFor(store: FavoritesByNetwork, network: string | null | undefined): readonly string[] {
  return network ? store[network] ?? [] : [];
}

/** Adds the pool (to the front) or removes it. Returns a new store. */
export function toggleFavorite(store: FavoritesByNetwork, network: string, poolId: string | number): FavoritesByNetwork {
  const id = String(poolId);
  if (!NETWORK_ID.test(network) || !POOL_ID.test(id)) return store;
  const current = store[network] ?? [];
  const next = current.includes(id) ? current.filter((value) => value !== id) : [id, ...current].slice(0, MAX_FAVORITES);
  const result: Record<string, readonly string[]> = { ...store, [network]: next };
  if (!next.length) delete result[network];
  return result;
}

/** The raw stored string, or null when storage is missing or blocked (private mode, disabled site data). */
export function readFavoritesRaw(storage: ReadStorage | null | undefined): string | null {
  try {
    return storage?.getItem(FAVORITES_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Toggles one pool and saves. Reads storage again first, so a change made in
 * another tab is kept. Returns false when the browser would not save it.
 */
export function saveFavoriteToggle(storage: WriteStorage | null | undefined, network: string, poolId: string | number): boolean {
  if (!storage) return false;
  const next = toggleFavorite(parseFavorites(readFavoritesRaw(storage)), network, poolId);
  try {
    storage.setItem(FAVORITES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
