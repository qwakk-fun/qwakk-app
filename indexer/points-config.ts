/**
 * Every tunable number of the Qwakk testnet points program. Each value comes
 * from a QWAKK_POINTS_* environment variable with the default shown here, so
 * the owner can retune a season without a code change. A changed value is
 * picked up on the next indexer start, and the whole season is rescored from
 * the stored raw events and snapshots.
 *
 * Units: QOR values are whole or decimal QOR (6 decimals) in the environment
 * and are converted to integer uqor here. Point rates are decimal strings
 * converted to integer millionths (ppm). Factors are basis points (10000 = 1x).
 *
 * Pools without a uqor side cannot be valued in QOR yet, so their swaps and
 * liquidity score 0 and they cannot unlock the pool bonus (see `qorPoolsOnly`).
 */

export type PointsConfig = {
  /** Points are off in public until this is true (QWAKK_POINTS_ENABLED=enabled). */
  enabled: boolean;
  season: string;
  /** First block of the season (inclusive). 0 means from the first indexed block. */
  seasonStartHeight: number;
  /** Last block of the season (inclusive). null means open ended. */
  seasonEndHeight: number | null;
  /** Owner, treasury and test addresses. They never appear on the leaderboard. */
  excludedAddresses: string[];

  /** Swaps smaller than this (uqor side) do not count for points, activity or pool unlocks. */
  minSwapUqor: bigint;
  /** Points per QOR of counted swap volume, in ppm. */
  swapPointsPerQorPpm: bigint;
  /** Daily counted volume per address scored at the full rate (uqor). */
  swapDailyFullUqor: bigint;
  /** Daily counted volume per address above which nothing more is scored (uqor). */
  swapDailyMaxUqor: bigint;
  /** Rate applied between the full and max daily volume, in bps. */
  swapExcessFactorBps: bigint;
  /** A reversing swap in the same pool by the same address within this window is a round trip. */
  roundTripWindowSeconds: number;
  /** Weight of round trip volume on both legs, in bps. */
  roundTripFactorBps: bigint;

  /** Points per QOR-hour of liquidity held, in ppm. */
  lpPointsPerQorHourPpm: bigint;
  /** Hourly position value per address scored at the full rate (uqor). */
  lpHourlyFullUqor: bigint;
  /** Hourly position value per address above which nothing more is scored (uqor). */
  lpHourlyMaxUqor: bigint;
  /** Rate applied between the full and max hourly value, in bps. */
  lpExcessFactorBps: bigint;
  /** A position must be held this many consecutive hours before any of its hours count. */
  lpMinHoldHours: number;
  /** Longest gap between two snapshots that is still credited, in hours. */
  lpMaxIntervalHours: number;

  /** One-time points for creating a pool once it is used by enough other traders. */
  poolBonusPointsPpm: bigint;
  /** Distinct traders (not the creator, not excluded) with counted swaps needed to unlock. */
  poolBonusMinTraders: number;
  /** Most pools per creator that can unlock the bonus in one season. */
  poolBonusMaxPerAddress: number;

  /** Points per distinct UTC day with at least one qualifying action, in ppm. */
  activeDayPointsPpm: bigint;
  /** Liquidity adds and pool creations count as activity only at or above this uqor amount. */
  minActionUqor: bigint;

  /** Only pools with a uqor side are scored for now. Kept explicit so the API can say so. */
  qorPoolsOnly: true;
};

export type PointsEnv = Record<string, string | undefined>;

const QOR_DECIMALS = 6;
const RATE_DECIMALS = 6;

function decimalToScaled(value: string, decimals: number): bigint | null {
  const text = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Reads the season config. Invalid values fall back to the default and are reported in `warnings`. */
export function loadPointsConfig(env: PointsEnv = process.env): { config: PointsConfig; warnings: string[] } {
  const warnings: string[] = [];

  function raw(name: string) {
    const value = env[name]?.trim();
    return value ? value : undefined;
  }

  function scaled(name: string, fallback: string, decimals: number) {
    const value = raw(name);
    const parsed = value === undefined ? null : decimalToScaled(value, decimals);
    if (value !== undefined && parsed === null) warnings.push(`${name} is not a valid decimal, using ${fallback}`);
    return parsed ?? (decimalToScaled(fallback, decimals) as bigint);
  }

  function integer(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const value = raw(name);
    if (value === undefined) return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      warnings.push(`${name} must be an integer between ${min} and ${max}, using ${fallback}`);
      return fallback;
    }
    return parsed;
  }

  const endHeight = integer("QWAKK_POINTS_SEASON_END_HEIGHT", 0);
  const excluded = new Set(
    [raw("QWAKK_POINTS_EXCLUDED_ADDRESSES") ?? "", raw("QWAKK_TREASURY_ADDRESS") ?? ""]
      .join(",")
      .split(/[\s,]+/)
      .map((address) => address.toLowerCase())
      .filter((address) => /^qor1[0-9a-z]{20,}$/.test(address)),
  );

  const config: PointsConfig = {
    enabled: ["enabled", "true", "1"].includes((raw("QWAKK_POINTS_ENABLED") ?? "").toLowerCase()),
    season: /^[a-z0-9-]{1,40}$/.test(raw("QWAKK_POINTS_SEASON") ?? "") ? raw("QWAKK_POINTS_SEASON") as string : "testnet-1",
    seasonStartHeight: integer("QWAKK_POINTS_SEASON_START_HEIGHT", 0),
    seasonEndHeight: endHeight > 0 ? endHeight : null,
    excludedAddresses: [...excluded].sort(),

    minSwapUqor: scaled("QWAKK_POINTS_MIN_SWAP_QOR", "1", QOR_DECIMALS),
    swapPointsPerQorPpm: scaled("QWAKK_POINTS_SWAP_POINTS_PER_QOR", "1", RATE_DECIMALS),
    swapDailyFullUqor: scaled("QWAKK_POINTS_SWAP_DAILY_FULL_QOR", "1000", QOR_DECIMALS),
    swapDailyMaxUqor: scaled("QWAKK_POINTS_SWAP_DAILY_MAX_QOR", "10000", QOR_DECIMALS),
    swapExcessFactorBps: BigInt(integer("QWAKK_POINTS_SWAP_EXCESS_FACTOR_BPS", 2000, 0, 10000)),
    roundTripWindowSeconds: integer("QWAKK_POINTS_ROUND_TRIP_WINDOW_SECONDS", 1800, 0, 30 * 86400),
    roundTripFactorBps: BigInt(integer("QWAKK_POINTS_ROUND_TRIP_FACTOR_BPS", 1000, 0, 10000)),

    lpPointsPerQorHourPpm: scaled("QWAKK_POINTS_LP_POINTS_PER_QOR_HOUR", "0.01", RATE_DECIMALS),
    lpHourlyFullUqor: scaled("QWAKK_POINTS_LP_HOURLY_FULL_QOR", "5000", QOR_DECIMALS),
    lpHourlyMaxUqor: scaled("QWAKK_POINTS_LP_HOURLY_MAX_QOR", "50000", QOR_DECIMALS),
    lpExcessFactorBps: BigInt(integer("QWAKK_POINTS_LP_EXCESS_FACTOR_BPS", 2000, 0, 10000)),
    lpMinHoldHours: integer("QWAKK_POINTS_LP_MIN_HOLD_HOURS", 6, 1, 24 * 30),
    lpMaxIntervalHours: integer("QWAKK_POINTS_LP_MAX_INTERVAL_HOURS", 3, 1, 48),

    poolBonusPointsPpm: scaled("QWAKK_POINTS_POOL_BONUS", "500", RATE_DECIMALS),
    poolBonusMinTraders: integer("QWAKK_POINTS_POOL_BONUS_MIN_TRADERS", 5, 1, 10000),
    poolBonusMaxPerAddress: integer("QWAKK_POINTS_POOL_BONUS_MAX_PER_ADDRESS", 3, 0, 1000),

    activeDayPointsPpm: scaled("QWAKK_POINTS_ACTIVE_DAY_POINTS", "50", RATE_DECIMALS),
    minActionUqor: scaled("QWAKK_POINTS_MIN_ACTION_QOR", "1", QOR_DECIMALS),

    qorPoolsOnly: true,
  };

  if (config.swapDailyMaxUqor < config.swapDailyFullUqor) {
    warnings.push("QWAKK_POINTS_SWAP_DAILY_MAX_QOR is below the full rate volume, using the full rate volume");
    config.swapDailyMaxUqor = config.swapDailyFullUqor;
  }
  if (config.lpHourlyMaxUqor < config.lpHourlyFullUqor) {
    warnings.push("QWAKK_POINTS_LP_HOURLY_MAX_QOR is below the full rate value, using the full rate value");
    config.lpHourlyMaxUqor = config.lpHourlyFullUqor;
  }
  if (config.seasonEndHeight !== null && config.seasonEndHeight < config.seasonStartHeight) {
    warnings.push("QWAKK_POINTS_SEASON_END_HEIGHT is below the start height, the season stays open ended");
    config.seasonEndHeight = null;
  }
  return { config, warnings };
}

/** Plain JSON view of the config, stored with every scoring run so a result can be traced to its rules. */
export function describePointsConfig(config: PointsConfig) {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => key !== "enabled")
      .map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
  );
}
