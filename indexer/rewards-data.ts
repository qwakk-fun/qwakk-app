/**
 * Database reads shared by the indexer API and indexer/rewards-cli.ts. Only
 * raw tables (lp_snapshots, liquidity_events, points_flags, indexer_state) are
 * read here; reward tables are written by the CLI alone.
 */

import type { Pool } from "pg";

import { epochSettlesAt, type EpochWindow, type RewardProgram, type RewardsConfig } from "./rewards-config";
import { allocateRewards, computeShareSeconds, type RewardRemoval, type RewardSnapshot } from "./rewards-math";

const HOUR_MS = 3_600_000;

/** Mirrors the configured programs into reward_programs, so epoch rows can reference them. */
export async function syncRewardPrograms(db: Pool, config: RewardsConfig) {
  for (const program of config.programs) {
    await db.query(
      `INSERT INTO reward_programs (id, label, pool_id, reward_denom, reward_symbol, reward_decimals, epoch_budget, epoch_anchor, epoch_seconds, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, pool_id = EXCLUDED.pool_id, reward_denom = EXCLUDED.reward_denom,
         reward_symbol = EXCLUDED.reward_symbol, reward_decimals = EXCLUDED.reward_decimals, epoch_budget = EXCLUDED.epoch_budget,
         epoch_anchor = EXCLUDED.epoch_anchor, epoch_seconds = EXCLUDED.epoch_seconds, updated_at = NOW()`,
      [program.id, program.label, program.poolId, program.rewardDenom, program.rewardSymbol, program.rewardDecimals, program.epochBudget.toString(), new Date(program.anchorMs), program.epochSeconds],
    );
  }
}

export async function lastIndexedHeight(db: Pool) {
  const row = (await db.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = 'last_indexed_height'")).rows[0];
  return row && /^\d+$/.test(row.value) ? Number(row.value) : 0;
}

/** The configured exclusions, plus the points program's automatic bot flags when QWAKK_REWARDS_EXCLUDE_POINTS_FLAGS is on. */
export async function rewardExclusions(db: Pool, config: RewardsConfig, pointsSeason: string) {
  const excluded = new Set(config.excludedAddresses);
  if (config.excludePointsFlags) {
    const flagged = await db.query<{ address: string }>("SELECT address FROM points_flags WHERE season = $1", [pointsSeason]);
    for (const row of flagged.rows) excluded.add(row.address.toLowerCase());
  }
  return [...excluded].sort();
}

/** Snapshots of the pool with snapshot_hour in [fromMs, toMs] and every removal in the pool. */
export async function loadShareData(db: Pool, poolId: string, fromMs: number, toMs: number) {
  const [snapshots, removals] = await Promise.all([
    db.query<{ address: string; snapshot_hour: Date; height: string; lp_balance: string }>(
      `SELECT address, snapshot_hour, height::text, lp_balance::text FROM lp_snapshots
       WHERE pool_id = $1 AND snapshot_hour >= $2 AND snapshot_hour <= $3
       ORDER BY address, snapshot_hour, height`,
      [poolId, new Date(fromMs), new Date(toMs)],
    ),
    db.query<{ sender: string; height: string; lp_amount: string | null }>(
      `SELECT sender, height::text, lp_amount::text FROM liquidity_events
       WHERE pool_id = $1 AND event_type = 'liquidity_removed' AND sender IS NOT NULL
       ORDER BY height, tx_hash, event_index`,
      [poolId],
    ),
  ]);
  const snapshotRows: RewardSnapshot[] = snapshots.rows.map((row) => ({ address: row.address, hourMs: row.snapshot_hour.getTime(), height: Number(row.height), lpBalance: row.lp_balance }));
  const removalRows: RewardRemoval[] = removals.rows.map((row) => ({ address: row.sender, height: Number(row.height), lpAmount: row.lp_amount }));
  const dataThroughHeight = snapshotRows.reduce((max, row) => Math.max(max, row.height), 0);
  return { snapshots: snapshotRows, removals: removalRows, dataThroughHeight };
}

export type EpochRules = { excluded: string[]; minHoldHours: number; maxGapHours: number; lookbackHours: number };

export function rulesFromConfig(config: RewardsConfig, excluded: string[]): EpochRules {
  return { excluded, minHoldHours: config.minHoldHours, maxGapHours: config.maxGapHours, lookbackHours: config.lookbackHours };
}

/**
 * Shares and allocations of one epoch. For a running epoch, `untilMs` cuts
 * the window at the present (an estimate). `settled` is true once every
 * snapshot the computation reads is final and the indexer has ingested the
 * liquidity events up to the latest of them.
 */
export async function computeEpoch(db: Pool, program: RewardProgram, window: EpochWindow, rules: EpochRules, budget: bigint, nowMs: number, untilMs = window.endMs) {
  const endMs = Math.min(untilMs, window.endMs);
  const readUntil = endMs < window.endMs ? endMs : window.endMs + rules.maxGapHours * HOUR_MS;
  const [data, indexedHeight] = await Promise.all([
    loadShareData(db, program.poolId, window.startMs - rules.lookbackHours * HOUR_MS, readUntil),
    lastIndexedHeight(db),
  ]);
  const computation = endMs > window.startMs
    ? computeShareSeconds(data.snapshots, data.removals, { startMs: window.startMs, endMs, minHoldHours: rules.minHoldHours, maxGapHours: rules.maxGapHours, excluded: rules.excluded })
    : { eligible: [], totalShareSeconds: BigInt(0), excludedShareSeconds: BigInt(0), warmingUp: new Map<string, number>() };
  const allocation = allocateRewards(budget, computation.eligible);
  const timeSettled = nowMs >= epochSettlesAt(window, rules.maxGapHours);
  const ingested = indexedHeight > 0 && indexedHeight >= data.dataThroughHeight;
  return {
    computation,
    allocation,
    dataThroughHeight: data.dataThroughHeight,
    indexedHeight,
    snapshotCount: data.snapshots.length,
    settled: timeSettled && ingested,
    notSettledReason: !timeSettled
      ? `the epoch settles at ${new Date(epochSettlesAt(window, rules.maxGapHours)).toISOString()}`
      : !ingested ? `the indexer is at height ${indexedHeight}, below the latest snapshot height ${data.dataThroughHeight}` : null,
  };
}
