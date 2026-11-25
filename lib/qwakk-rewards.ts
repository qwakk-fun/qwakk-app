/**
 * Liquidity rewards: the public API stays off until the program works end to
 * end. Set QWAKK_REWARDS_ENABLED=enabled on both the web app and the indexer.
 * Amounts are base units of the reward token as strings; format them with
 * `rewardDecimals`, never with float math.
 */
export function rewardsEnabled() {
  return ["enabled", "true", "1", "on"].includes(process.env.QWAKK_REWARDS_ENABLED?.trim().toLowerCase() ?? "");
}

export function isRewardsAddress(value: string) {
  return /^qor1[0-9a-z]{20,}$/.test(value);
}

export type QwakkRewardEpochStatus = "draft" | "finalized" | "registered";

export type QwakkRewardEpoch = {
  number: number;
  startsAt: string;
  endsAt: string;
  status: QwakkRewardEpochStatus;
  stageId: number | null;
  root: string | null;
  budget: string;
  totalAllocated: string | null;
  /** Rounding remainder left unallocated. */
  dust: string | null;
  recipients: number | null;
  finalizedAt: string | null;
  registeredAt: string | null;
  registerTxHash: string | null;
  /** The contract accepts claims in [claimStartsAt, claimEndsAt). */
  claimStartsAt: string | null;
  claimEndsAt: string | null;
};

export type QwakkRewardProgram = {
  id: string;
  label: string;
  poolId: string;
  rewardDenom: string;
  rewardSymbol: string;
  rewardDecimals: number;
  epochSeconds: number;
  epochBudget: string;
  firstEpochStartsAt: string;
  /** Null before the first epoch starts. */
  currentEpoch: {
    number: number;
    startsAt: string;
    endsAt: string;
    budget: string;
    participants: number;
    warmingUp: number;
    eligibleShareSeconds: string;
    computedAt: string;
    throughHeight: number | null;
  } | null;
  /** Finalized and registered epochs, newest first (up to 12). */
  epochs: QwakkRewardEpoch[];
};

export type QwakkRewardProgramsResponse = {
  programs: QwakkRewardProgram[];
  rules: { minHoldHours: number; maxGapHours: number };
};

export type QwakkRewardClaim = {
  programId: string;
  epoch: number;
  stageId: number;
  /** Only a registered stage can be claimed on chain. */
  status: QwakkRewardEpochStatus;
  startsAt: string;
  endsAt: string;
  /** The contract accepts claims in [claimStartsAt, claimEndsAt). */
  claimStartsAt: string | null;
  claimEndsAt: string | null;
  poolId: string;
  rewardDenom: string;
  rewardSymbol: string | null;
  rewardDecimals: number | null;
  amount: string;
  shareSeconds: string;
  root: string;
  leaf: string;
  /** Sibling hashes, hex, bottom up. */
  proof: string[];
};

export type QwakkRewardAccrual = {
  programId: string;
  poolId: string;
  rewardDenom: string;
  rewardSymbol: string;
  rewardDecimals: number;
  epoch: number;
  startsAt: string;
  endsAt: string;
  status: "earning" | "warming_up" | "not_earning" | "excluded";
  shareSeconds: string;
  totalShareSeconds: string;
  /** Share of the eligible liquidity so far, parts per million. */
  sharePpm: string;
  /** Epoch budget split by the shares so far. An estimate until the epoch is finalized. */
  estimatedAmount: string;
  /** Hours held so far while nothing has passed the minimum hold yet. */
  warmingUpHours: number | null;
  minHoldHours: number;
  computedAt: string;
};

export type QwakkRewardsAddressResponse = {
  address: string;
  excluded: boolean;
  /** Finalized and registered allocations with their proofs, newest first. Already claimed stages are not tracked here: ask the contract. */
  claims: QwakkRewardClaim[];
  current: QwakkRewardAccrual[];
};
