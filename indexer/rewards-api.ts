/**
 * Read-only reward views served by the indexer under /rewards/ while
 * QWAKK_REWARDS_ENABLED is on. Amounts are base units of the reward denom as
 * strings; the web formats them with `rewardDecimals`.
 *
 * Finalized and registered epochs come from reward_epochs and
 * reward_allocations (written by indexer/rewards-cli.ts). The running epoch is
 * an estimate computed from the indexed LP snapshots, cached for a minute.
 */

import type { Pool } from "pg";

import { epochAt, type EpochWindow, type RewardProgram, type RewardsConfig } from "./rewards-config";
import { computeEpoch, rewardExclusions, rulesFromConfig } from "./rewards-data";
import { sharePpm } from "./rewards-math";

const CURRENT_TTL_MS = 60_000;
const EPOCH_HISTORY = 12;

type CurrentEstimate = {
  window: EpochWindow;
  computedAt: number;
  excluded: Set<string>;
  shares: Map<string, bigint>;
  totalShareSeconds: bigint;
  amounts: Map<string, bigint>;
  warmingUp: Map<string, number>;
  dataThroughHeight: number;
};

export function createRewardsApi(db: Pool, config: RewardsConfig, pointsSeason: string) {
  const cache = new Map<string, { at: number; value: Promise<CurrentEstimate | null> }>();

  async function estimate(program: RewardProgram): Promise<CurrentEstimate | null> {
    const now = Date.now();
    const window = epochAt(program, now);
    if (!window) return null;
    const excluded = await rewardExclusions(db, config, pointsSeason);
    const result = await computeEpoch(db, program, window, rulesFromConfig(config, excluded), program.epochBudget, now, now);
    return {
      window,
      computedAt: now,
      excluded: new Set(excluded),
      shares: new Map(result.computation.eligible.map((entry) => [entry.address, entry.shareSeconds])),
      totalShareSeconds: result.computation.totalShareSeconds,
      amounts: new Map(result.allocation.allocations.map((entry) => [entry.address, entry.amount])),
      warmingUp: result.computation.warmingUp,
      dataThroughHeight: result.dataThroughHeight,
    };
  }

  /** One computation per program per minute, shared by concurrent requests. A failed one is not cached. */
  function current(program: RewardProgram) {
    const cached = cache.get(program.id);
    if (cached && Date.now() - cached.at < CURRENT_TTL_MS) return cached.value;
    const value = estimate(program);
    cache.set(program.id, { at: Date.now(), value });
    value.catch(() => cache.delete(program.id));
    return value;
  }

  async function programs() {
    const epochs = await db.query<{
      program_id: string; epoch_number: number; starts_at: Date; ends_at: Date; status: string; stage_id: string | null; merkle_root: string | null;
      budget: string; total_allocated: string | null; dust: string | null; recipients: number | null; finalized_at: Date | null; registered_at: Date | null; register_tx_hash: string | null;
      claim_starts_at: Date | null; claim_ends_at: Date | null;
    }>(
      `SELECT program_id, epoch_number, starts_at, ends_at, status, stage_id::text, merkle_root, budget::text, total_allocated::text, dust::text, recipients,
              finalized_at, registered_at, register_tx_hash, claim_starts_at, claim_ends_at
       FROM reward_epochs WHERE program_id = ANY($1) AND status IN ('finalized', 'registered') ORDER BY epoch_number DESC`,
      [config.programs.map((program) => program.id)],
    );
    const list = await Promise.all(config.programs.map(async (program) => {
      const estimateNow = await current(program);
      return {
        id: program.id,
        label: program.label,
        poolId: program.poolId,
        rewardDenom: program.rewardDenom,
        rewardSymbol: program.rewardSymbol,
        rewardDecimals: program.rewardDecimals,
        epochSeconds: program.epochSeconds,
        epochBudget: program.epochBudget.toString(),
        firstEpochStartsAt: new Date(program.anchorMs).toISOString(),
        currentEpoch: estimateNow ? {
          number: estimateNow.window.number,
          startsAt: new Date(estimateNow.window.startMs).toISOString(),
          endsAt: new Date(estimateNow.window.endMs).toISOString(),
          budget: program.epochBudget.toString(),
          participants: estimateNow.shares.size,
          warmingUp: estimateNow.warmingUp.size,
          eligibleShareSeconds: estimateNow.totalShareSeconds.toString(),
          computedAt: new Date(estimateNow.computedAt).toISOString(),
          throughHeight: estimateNow.dataThroughHeight || null,
        } : null,
        epochs: epochs.rows.filter((row) => row.program_id === program.id).slice(0, EPOCH_HISTORY).map((row) => ({
          number: row.epoch_number,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at.toISOString(),
          status: row.status,
          stageId: row.stage_id === null ? null : Number(row.stage_id),
          root: row.merkle_root,
          budget: row.budget,
          totalAllocated: row.total_allocated,
          dust: row.dust,
          recipients: row.recipients,
          finalizedAt: row.finalized_at?.toISOString() ?? null,
          registeredAt: row.registered_at?.toISOString() ?? null,
          registerTxHash: row.register_tx_hash,
          claimStartsAt: row.claim_starts_at?.toISOString() ?? null,
          claimEndsAt: row.claim_ends_at?.toISOString() ?? null,
        })),
      };
    }));
    return { programs: list, rules: { minHoldHours: config.minHoldHours, maxGapHours: config.maxGapHours } };
  }

  async function address(addressText: string) {
    const claims = await db.query<{
      program_id: string; epoch_number: number; stage_id: string; status: string; starts_at: Date; ends_at: Date; merkle_root: string;
      amount: string; share_seconds: string; leaf: string; proof: string[]; pool_id: string; claim_starts_at: Date | null; claim_ends_at: Date | null; reward_denom: string; reward_symbol: string | null; reward_decimals: number | null;
    }>(
      // Token details come from the epoch row, so a claim stays served after its program leaves the config.
      `SELECT a.program_id, a.epoch_number, e.stage_id::text, e.status, e.starts_at, e.ends_at, e.merkle_root, a.amount::text, a.share_seconds::text, a.leaf, a.proof,
              e.pool_id::text, e.claim_starts_at, e.claim_ends_at, e.reward_denom, e.config->>'rewardSymbol' AS reward_symbol, (e.config->>'rewardDecimals')::int AS reward_decimals
       FROM reward_allocations a JOIN reward_epochs e ON e.program_id = a.program_id AND e.epoch_number = a.epoch_number
       WHERE a.address = $1 AND e.status IN ('finalized', 'registered') AND e.stage_id IS NOT NULL
       ORDER BY e.ends_at DESC, a.program_id`,
      [addressText],
    );
    const currentEntries = await Promise.all(config.programs.map(async (program) => {
      const estimateNow = await current(program);
      if (!estimateNow) return null;
      const shareSeconds = estimateNow.shares.get(addressText) ?? BigInt(0);
      const excluded = estimateNow.excluded.has(addressText);
      const warmingUpHours = estimateNow.warmingUp.get(addressText) ?? null;
      const status = excluded ? "excluded" : shareSeconds > BigInt(0) ? "earning" : warmingUpHours !== null ? "warming_up" : "not_earning";
      return {
        programId: program.id,
        poolId: program.poolId,
        rewardDenom: program.rewardDenom,
        rewardSymbol: program.rewardSymbol,
        rewardDecimals: program.rewardDecimals,
        epoch: estimateNow.window.number,
        startsAt: new Date(estimateNow.window.startMs).toISOString(),
        endsAt: new Date(estimateNow.window.endMs).toISOString(),
        status,
        shareSeconds: shareSeconds.toString(),
        totalShareSeconds: estimateNow.totalShareSeconds.toString(),
        sharePpm: sharePpm(shareSeconds, estimateNow.totalShareSeconds).toString(),
        /** The full epoch budget split by the shares so far. An estimate: it changes until the epoch is finalized. */
        estimatedAmount: (estimateNow.amounts.get(addressText) ?? BigInt(0)).toString(),
        warmingUpHours,
        minHoldHours: config.minHoldHours,
        computedAt: new Date(estimateNow.computedAt).toISOString(),
      };
    }));
    const running = currentEntries.filter((entry) => entry !== null);
    return {
      address: addressText,
      excluded: config.excludedAddresses.includes(addressText) || running.some((entry) => entry.status === "excluded"),
      claims: claims.rows.map((row) => ({
        programId: row.program_id,
        epoch: row.epoch_number,
        stageId: Number(row.stage_id),
        /** Only a registered stage can be claimed on chain. */
        status: row.status,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        /** The contract accepts claims in [claimStartsAt, claimEndsAt). */
        claimStartsAt: row.claim_starts_at?.toISOString() ?? null,
        claimEndsAt: row.claim_ends_at?.toISOString() ?? null,
        poolId: row.pool_id,
        rewardDenom: row.reward_denom,
        rewardSymbol: row.reward_symbol,
        rewardDecimals: row.reward_decimals,
        amount: row.amount,
        shareSeconds: row.share_seconds,
        root: row.merkle_root,
        leaf: row.leaf,
        proof: row.proof,
      })),
      current: running,
    };
  }

  return { programs, address };
}
