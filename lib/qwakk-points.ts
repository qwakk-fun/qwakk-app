/**
 * Testnet points: the public API stays off until the program works end to
 * end. Set QWAKK_POINTS_ENABLED=enabled on both the web app and the indexer.
 * Points are a ranking of on-chain activity on Qwakk pools. They have no
 * monetary value and are not a token.
 */
export function pointsEnabled() {
  return ["enabled", "true", "1"].includes(process.env.QWAKK_POINTS_ENABLED?.trim().toLowerCase() ?? "");
}

export const QWAKK_POINTS_PAGE_SIZE = 25;
export const QWAKK_POINTS_MAX_PAGE_SIZE = 100;

export function isPointsAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/.test(value);
}

/** Points are exact decimal strings (up to 6 places). Format them for display, do not do math on them as floats. */
export type QwakkPointsBreakdown = { swaps: string; liquidity: string; pools: string; activity: string };

export type QwakkPointsSeason = {
  id: string;
  startHeight: number;
  endHeight: number | null;
  /** When the season was last scored (ISO), null before the first run. */
  computedAt: string | null;
  /** Highest block included in the scores. */
  throughHeight: number | null;
  participants: number;
  /** Short hash of the scoring rules used for this run. */
  rulesVersion: string;
};

export type QwakkLeaderboardEntry = {
  rank: number;
  address: string;
  totalPoints: string;
  breakdown: QwakkPointsBreakdown;
  activeDays: number;
};

export type QwakkLeaderboardResponse = {
  season: QwakkPointsSeason;
  entries: QwakkLeaderboardEntry[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export type QwakkPoolBonusStatus = "locked" | "unlocked" | "over_limit" | "not_scored";

export type QwakkPointsAddressResponse = {
  season: QwakkPointsSeason;
  address: string;
  ranked: boolean;
  rank: number | null;
  totalPoints: string;
  breakdown: QwakkPointsBreakdown;
  activeDays: number;
  stats: {
    /** Counted swap volume (swaps at or above the minimum size that scored), in QOR. */
    swapVolumeQor: string;
    /** Part of that volume matched as a quick reversal, in QOR. */
    roundTripVolumeQor: string;
    /** Position value times hours held, in QOR-hours. */
    liquidityQorHours: string;
    poolsCreated: number;
    poolsUnlocked: number;
    /**
     * Volume of swaps at or above the minimum size that scored nothing, in QOR,
     * by reason: made outside Qwakk (no interface fee in the transaction), a
     * second or later swap in one transaction, or too soon after the previous
     * counted swap. Missing from indexers older than this rule.
     */
    ignoredSwapVolumeQor?: { notOnQwakk: string; extraInTx: string; tooSoon: string };
  };
  /**
   * Present when the address looks automated: it is not ranked this season
   * and has no points. Reasons: "manual", "batch_swaps", "burst_trading",
   * "direct_swaps".
   */
  flagged?: { reasons: string[] };
  pools: Array<{ poolId: string; distinctTraders: number; requiredTraders: number; status: QwakkPoolBonusStatus; points: string }>;
  /** Newest first, up to 90 days. */
  days: Array<{ day: string; swapVolumeQor: string; roundTripVolumeQor: string; swapPoints: string; liquidityPoints: string; active: boolean }>;
};
