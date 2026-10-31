/**
 * Indexer settings that come from the environment, kept pure so tests can
 * call them. See indexer/README.md for every variable and its default.
 *
 * The network presets mirror lib/qwakk-network.ts. The indexer image copies
 * only indexer/, so it cannot import that file; keep both in step.
 */

export type IndexerNetworkId = "testnet" | "mainnet";

export type IndexerNetwork = { id: IndexerNetworkId; chainId: string; restUrl: string; rpcUrl: string };

export const INDEXER_NETWORK_PRESETS: Readonly<Record<IndexerNetworkId, IndexerNetwork>> = {
  testnet: { id: "testnet", chainId: "qorechain-diana", restUrl: "https://api-testnet.qore.host", rpcUrl: "https://rpc-testnet.qore.host" },
  mainnet: { id: "mainnet", chainId: "qorechain-vladi", restUrl: "https://api.qore.host", rpcUrl: "https://rpc.qore.host" },
};

export type Env = Readonly<Record<string, string | undefined>>;

function cleanUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** QWAKK_NETWORK as the app reads it: testnet or mainnet, anything else falls back to testnet. */
export function networkIdFromEnv(env: Env): { id: IndexerNetworkId; warning: string | null } {
  const raw = env.QWAKK_NETWORK?.trim().toLowerCase() ?? "";
  if (raw === "testnet" || raw === "mainnet") return { id: raw, warning: null };
  return { id: "testnet", warning: raw ? `QWAKK_NETWORK="${raw}" is not testnet or mainnet. Using testnet.` : null };
}

/**
 * The network to index. QORECHAIN_REST_URL and QORECHAIN_RPC_URL override the
 * preset (a private node, for example), except a value that is exactly the
 * other network's public endpoint: that is a leftover from switching networks
 * and is ignored with a warning, as lib/qwakk-network.ts does. The chain id
 * guard catches every other mismatch before anything is written.
 */
export function resolveIndexerNetwork(env: Env): { network: IndexerNetwork; warnings: string[] } {
  const { id, warning } = networkIdFromEnv(env);
  const warnings = warning ? [warning] : [];
  const network: IndexerNetwork = { ...INDEXER_NETWORK_PRESETS[id] };
  const other = INDEXER_NETWORK_PRESETS[id === "mainnet" ? "testnet" : "mainnet"];
  for (const [key, name] of [["restUrl", "QORECHAIN_REST_URL"], ["rpcUrl", "QORECHAIN_RPC_URL"]] as const) {
    const value = env[name]?.trim();
    if (!value) continue;
    const url = cleanUrl(value);
    if (!isHttpUrl(url)) {
      warnings.push(`${name} is not an http(s) URL. Using the ${id} default.`);
      continue;
    }
    if (url === other[key]) {
      warnings.push(`${name} points at the ${other.id} endpoint while QWAKK_NETWORK is ${id}. Using the ${id} default.`);
      continue;
    }
    network[key] = url;
  }
  return { network, warnings };
}

export type ChainGuardInput = {
  /** Chain id of the configured network. */
  configured: string;
  /** node_info.network from the RPC /status. */
  node: string;
  /** indexer_state.chain_id, when this database has one. */
  stored: string | null;
  /** True when the database already holds indexed data (a saved height or pools). */
  databaseHasData: boolean;
  /** QWAKK_INDEXER_ADOPT_CHAIN_ID: the owner's confirmation of which chain an older, unlabeled database holds. */
  adopt: string | null;
};

export type ChainGuardVerdict = { action: "ok" } | { action: "store"; chainId: string } | { action: "refuse"; reason: string };

/** Databases written before the guard existed were only ever filled from the testnet. */
const LEGACY_CHAIN_ID = INDEXER_NETWORK_PRESETS.testnet.chainId;

/**
 * Decides whether the indexer may write. A mainnet indexer must never write
 * into a testnet database or the reverse, so every mismatch refuses to start.
 */
export function chainGuard(input: ChainGuardInput): ChainGuardVerdict {
  if (input.node !== input.configured) {
    return { action: "refuse", reason: `The QoreChain node serves ${input.node || "an unknown chain"}, but this indexer is configured for ${input.configured}. Check QWAKK_NETWORK, QORECHAIN_RPC_URL and QORECHAIN_REST_URL.` };
  }
  if (input.stored !== null) {
    return input.stored === input.configured
      ? { action: "ok" }
      : { action: "refuse", reason: `This database holds ${input.stored} data, but this indexer is configured for ${input.configured}. Use a separate database for each network.` };
  }
  if (!input.databaseHasData) return { action: "store", chainId: input.configured };
  // An older database without a label: it was filled from the testnet unless the owner says otherwise.
  const holds = input.adopt?.trim() || LEGACY_CHAIN_ID;
  return holds === input.configured
    ? { action: "store", chainId: holds }
    : { action: "refuse", reason: `This database already holds indexed data from before chain ids were recorded (assumed ${holds}), but this indexer is configured for ${input.configured}. Use a fresh database, or set QWAKK_INDEXER_ADOPT_CHAIN_ID=${input.configured} if you are sure it holds ${input.configured} data.` };
}

function integerEnv(env: Env, name: string, fallback: number, min: number, warnings: string[]) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    warnings.push(`${name}="${raw}" is not a whole number. Using ${fallback}.`);
    return fallback;
  }
  const value = Number(raw);
  if (value !== 0 && value < min) {
    warnings.push(`${name}=${value} is below the minimum ${min}. Using ${min}.`);
    return min;
  }
  return value;
}

export type HealthConfig = { maxLag: number; maxSyncAgeSeconds: number };

/** QWAKK_INDEXER_MAX_LAG matches the web's DEFAULT_MAX_INDEXER_LAG (lib/qwakk-health.ts). */
export function healthConfig(env: Env, warnings: string[] = []): HealthConfig {
  return {
    maxLag: integerEnv(env, "QWAKK_INDEXER_MAX_LAG", 600, 1, warnings) || 600,
    maxSyncAgeSeconds: integerEnv(env, "QWAKK_INDEXER_MAX_SYNC_AGE_SECONDS", 120, 15, warnings) || 120,
  };
}

export type SyncState = {
  chainId: string | null;
  /** Last indexed block, from indexer_state. */
  height: number | null;
  /** Chain tip from the last /status read. */
  chainHeight: number | null;
  lastSyncAt: Date | null;
  lastErrorAt: Date | null;
  startedAt: Date;
};

export type HealthStatus = "starting" | "ok" | "lagging" | "stalled";

/**
 * Health verdict. Not ok when the indexer is more than maxLag blocks behind
 * the chain, or has not finished a sync for maxSyncAgeSeconds (sync failing,
 * chain unreachable). A process younger than maxSyncAgeSeconds that has not
 * synced yet reads "starting" and is not ok either.
 */
export function evaluateIndexerHealth(state: SyncState, config: HealthConfig, now: Date) {
  const lag = state.height !== null && state.chainHeight !== null ? Math.max(0, state.chainHeight - state.height) : null;
  const syncAge = state.lastSyncAt ? (now.getTime() - state.lastSyncAt.getTime()) / 1000 : null;
  const uptime = (now.getTime() - state.startedAt.getTime()) / 1000;
  let status: HealthStatus;
  if (syncAge === null) status = uptime < config.maxSyncAgeSeconds ? "starting" : "stalled";
  else if (syncAge > config.maxSyncAgeSeconds) status = "stalled";
  else if (lag === null || lag > config.maxLag) status = "lagging";
  else status = "ok";
  return {
    ok: status === "ok",
    status,
    chainId: state.chainId,
    height: state.height === null ? null : String(state.height),
    chainHeight: state.chainHeight === null ? null : String(state.chainHeight),
    lag,
    maxLag: config.maxLag,
    lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
    lastErrorAt: state.lastErrorAt?.toISOString() ?? null,
  };
}

/**
 * Retention of rolling and derived data. Each period is in days; 0 turns that
 * rule off, and QWAKK_RETENTION=off turns the whole job off. Candle periods
 * can never go below the window the API serves for that interval.
 */
export type RetentionConfig = {
  enabled: boolean;
  intervalMinutes: number;
  candles1mDays: number;
  candles5mDays: number;
  swapRawEventDays: number;
  /** Used only while points are off; with points on, snapshots before the season start are pruned instead. */
  lpSnapshotDays: number;
};

export function retentionConfig(env: Env, warnings: string[] = []): RetentionConfig {
  const switchValue = env.QWAKK_RETENTION?.trim().toLowerCase() ?? "";
  return {
    enabled: !["off", "false", "0", "disabled"].includes(switchValue),
    intervalMinutes: integerEnv(env, "QWAKK_RETENTION_INTERVAL_MINUTES", 60, 5, warnings) || 60,
    // Served windows: 1m 24 hours, 5m 3 days (CHART_WINDOWS in market-math.ts).
    candles1mDays: integerEnv(env, "QWAKK_RETENTION_CANDLES_1M_DAYS", 7, 2, warnings),
    candles5mDays: integerEnv(env, "QWAKK_RETENTION_CANDLES_5M_DAYS", 14, 4, warnings),
    swapRawEventDays: integerEnv(env, "QWAKK_RETENTION_SWAP_RAW_EVENT_DAYS", 30, 1, warnings),
    lpSnapshotDays: integerEnv(env, "QWAKK_RETENTION_LP_SNAPSHOT_DAYS", 90, 7, warnings),
  };
}

/**
 * First block to index on a fresh database. QWAKK_INDEXER_START_HEIGHT wins.
 * Otherwise, when pools already exist, indexing starts at the earliest pool's
 * creation block so its history is kept (swaps cannot exist before a pool);
 * with no pools it starts at the chain tip. Never below the node's earliest
 * kept block (Diana prunes, mainnet keeps every block).
 * Returns the height to save as "last indexed", i.e. one before the first block.
 */
export function freshStartHeight(input: { configured: number; currentHeight: number; earliestHeight: number; firstPoolHeight: number | null }) {
  const floor = Math.max(1, input.earliestHeight);
  let first: number;
  if (Number.isSafeInteger(input.configured) && input.configured > 0 && input.configured <= input.currentHeight) first = input.configured;
  else if (input.firstPoolHeight !== null && input.firstPoolHeight > 0 && input.firstPoolHeight <= input.currentHeight) first = input.firstPoolHeight;
  else return input.currentHeight;
  return Math.max(first, floor) - 1;
}

export type LpSnapshotRule = { kind: "below_height"; height: number } | { kind: "older_than_days"; days: number } | null;

/**
 * Which LP snapshots retention may delete. Scoring rebuilds a season from the
 * snapshots at or above its start height, and it runs whether or not points
 * are public, so a configured season always wins: only snapshots below its
 * start height go. The rolling window applies only when no season is set.
 * Either way the caller keeps each position's latest snapshot.
 */
export function lpSnapshotRule(seasonStartHeight: number, lpSnapshotDays: number): LpSnapshotRule {
  if (Number.isSafeInteger(seasonStartHeight) && seasonStartHeight > 0) return { kind: "below_height", height: seasonStartHeight };
  return lpSnapshotDays > 0 ? { kind: "older_than_days", days: lpSnapshotDays } : null;
}

/**
 * Offline tools (rebuild-candles.ts) cannot ask the node, so they check the
 * database label against the configured network. An unlabeled database is
 * refused unless the operator names its chain explicitly, and that name must
 * match the configured network.
 */
export function databaseNetworkCheck(input: { configured: string; stored: string | null; assumed: string | null }): { ok: true } | { ok: false; reason: string } {
  if (input.stored !== null) {
    return input.stored === input.configured
      ? { ok: true }
      : { ok: false, reason: `This database holds ${input.stored} data, but QWAKK_NETWORK selects ${input.configured}. Set QWAKK_NETWORK to match the database.` };
  }
  if (!input.assumed) {
    return { ok: false, reason: `This database has no chain id label yet (the indexer writes it on start). Pass --assume-chain-id ${input.configured} if you are sure it holds ${input.configured} data.` };
  }
  return input.assumed === input.configured
    ? { ok: true }
    : { ok: false, reason: `--assume-chain-id ${input.assumed} does not match QWAKK_NETWORK, which selects ${input.configured}.` };
}
