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
 *
 * Anti-bot rules: a swap counts only when its transaction also paid Qwakk's
 * interface fee to the treasury (the Qwakk route), only the first swap of a
 * transaction counts, and a swap too soon after the address's previous
 * counted swap scores nothing. Addresses that look automated are flagged and
 * left off the leaderboard for the whole season.
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

  /**
   * Swaps count only when the same transaction paid at least the minimum
   * interface fee from the swap sender to one of `feeRecipients`
   * (QWAKK_POINTS_REQUIRE_INTERFACE_FEE, default on). Off when no valid
   * recipient is configured: then there is nothing to check. When off, the
   * direct swap bot signal is off too.
   */
  requireInterfaceFee: boolean;
  /**
   * QWAKK_TREASURY_ADDRESS plus QWAKK_POINTS_PAST_TREASURY_ADDRESSES, lower
   * case and sorted. A fee paid to any of them counts, so the treasury can be
   * rotated mid-season as long as the old address stays listed.
   */
  feeRecipients: string[];
  /**
   * Smallest fee that proves the Qwakk route, in bps of the swap input
   * (QWAKK_POINTS_MIN_INTERFACE_FEE_BPS, default 10). Independent of the fee
   * the app charges (QWAKK_SWAP_FEE_BPS), so raising the app fee never
   * changes past results. Keep it at or below the app fee.
   */
  minInterfaceFeeBps: number;
  /**
   * Room for exact-out swaps, whose AMM leg may take up to 5% more than the
   * quoted leg the fee was set on: the fee must be at least
   * floor(amountIn * minInterfaceFeeBps / (10000 + slack)), and at least 1.
   */
  interfaceFeeSlackBps: number;
  /** Only the first swap of a transaction counts. Always on. */
  oneSwapPerTx: true;
  /** A swap less than this many seconds after the address's previous counted swap scores nothing. 0 turns it off. */
  minSwapGapSeconds: number;

  /** Addresses always flagged as automated (QWAKK_POINTS_BOT_ADDRESSES). */
  botAddresses: string[];
  /** Addresses never flagged by the automatic signals (QWAKK_POINTS_BOT_ALLOWLIST). */
  botAllowlist: string[];
  /** Flag an address with any in-season transaction holding at least this many swaps. 0 turns it off. */
  botBatchMinSwaps: number;
  /**
   * Flag an address with at least this many swaps on one UTC day... 0 turns it off.
   * While the fee rule is on, swaps that paid the interface fee are left out:
   * they are already throttled by `minSwapGapSeconds`.
   */
  botBurstMinSwaps: number;
  /** ...whose median gap between consecutive swaps that day is below this many seconds. */
  botBurstMedianGapSeconds: number;
  /**
   * Flag an address with at least this many in-season swaps whose sender sent
   * nothing to anyone in the transaction besides the swap itself (plain x/amm
   * use). 0 turns it off. A Qwakk swap always carries a fee transfer, so a
   * wrong fee recipient setting can never make a Qwakk trader look direct.
   */
  botDirectMinSwaps: number;

  /** Only pools with a uqor side are scored for now. Kept explicit so the API can say so. */
  qorPoolsOnly: true;
};

export type PointsEnv = Record<string, string | undefined>;

const QOR_DECIMALS = 6;
const ADDRESS_PATTERN = /^qor1[0-9a-z]{20,}$/;
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

  function addresses(...names: string[]) {
    return [...new Set(
      names.map((name) => raw(name) ?? "")
        .join(",")
        .split(/[\s,]+/)
        .map((address) => address.toLowerCase())
        .filter((address) => ADDRESS_PATTERN.test(address)),
    )].sort();
  }

  function toggle(name: string, fallback: boolean) {
    const value = raw(name)?.toLowerCase();
    if (value === undefined) return fallback;
    if (["enabled", "true", "1"].includes(value)) return true;
    if (["disabled", "false", "0"].includes(value)) return false;
    warnings.push(`${name} must be enabled or disabled, using ${fallback ? "enabled" : "disabled"}`);
    return fallback;
  }

  const endHeight = integer("QWAKK_POINTS_SEASON_END_HEIGHT", 0);
  const feeRecipients = addresses("QWAKK_TREASURY_ADDRESS", "QWAKK_POINTS_PAST_TREASURY_ADDRESSES");
  // Unset means "on where it can be checked": without any treasury the app charges no fee.
  const feeRuleSet = raw("QWAKK_POINTS_REQUIRE_INTERFACE_FEE") !== undefined;
  let requireInterfaceFee = toggle("QWAKK_POINTS_REQUIRE_INTERFACE_FEE", true);
  if (requireInterfaceFee && feeRecipients.length === 0) {
    if (feeRuleSet) warnings.push("QWAKK_POINTS_REQUIRE_INTERFACE_FEE needs a valid QWAKK_TREASURY_ADDRESS, so it is off");
    requireInterfaceFee = false;
  }

  const config: PointsConfig = {
    enabled: ["enabled", "true", "1"].includes((raw("QWAKK_POINTS_ENABLED") ?? "").toLowerCase()),
    season: /^[a-z0-9-]{1,40}$/.test(raw("QWAKK_POINTS_SEASON") ?? "") ? raw("QWAKK_POINTS_SEASON") as string : "testnet-1",
    seasonStartHeight: integer("QWAKK_POINTS_SEASON_START_HEIGHT", 0),
    seasonEndHeight: endHeight > 0 ? endHeight : null,
    excludedAddresses: addresses("QWAKK_POINTS_EXCLUDED_ADDRESSES", "QWAKK_TREASURY_ADDRESS", "QWAKK_POINTS_PAST_TREASURY_ADDRESSES"),

    minSwapUqor: scaled("QWAKK_POINTS_MIN_SWAP_QOR", "1", QOR_DECIMALS),
    swapPointsPerQorPpm: scaled("QWAKK_POINTS_SWAP_POINTS_PER_QOR", "1", RATE_DECIMALS),
    swapDailyFullUqor: scaled("QWAKK_POINTS_SWAP_DAILY_FULL_QOR", "1000", QOR_DECIMALS),
    swapDailyMaxUqor: scaled("QWAKK_POINTS_SWAP_DAILY_MAX_QOR", "2000", QOR_DECIMALS),
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

    requireInterfaceFee,
    feeRecipients,
    minInterfaceFeeBps: integer("QWAKK_POINTS_MIN_INTERFACE_FEE_BPS", 10, 0, 30),
    interfaceFeeSlackBps: 500,
    oneSwapPerTx: true,
    minSwapGapSeconds: integer("QWAKK_POINTS_MIN_SWAP_GAP_SECONDS", 60, 0, 86400),

    botAddresses: addresses("QWAKK_POINTS_BOT_ADDRESSES"),
    botAllowlist: addresses("QWAKK_POINTS_BOT_ALLOWLIST"),
    botBatchMinSwaps: integer("QWAKK_POINTS_BOT_BATCH_MIN_SWAPS", 2, 0, 1000),
    botBurstMinSwaps: integer("QWAKK_POINTS_BOT_BURST_MIN_SWAPS", 10, 0, 100000),
    botBurstMedianGapSeconds: integer("QWAKK_POINTS_BOT_BURST_MEDIAN_GAP_SECONDS", 30, 0, 86400),
    botDirectMinSwaps: integer("QWAKK_POINTS_BOT_DIRECT_MIN_SWAPS", 5, 0, 100000),

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
