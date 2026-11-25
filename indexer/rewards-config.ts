/**
 * Qwakk liquidity rewards: configuration and epoch windows.
 *
 * A rewards program pays the LPs of one pool in one token, per weekly epoch,
 * by time-weighted LP share. Each program comes from QWAKK_REWARDS_PROGRAMS (a
 * JSON array, so more programs can be added without a code change). The
 * public API stays off until QWAKK_REWARDS_ENABLED is on; raw LP data is
 * collected either way, and the owner can preview and finalize epochs with
 * indexer/rewards-cli.ts while the API is off.
 *
 * Amounts are base units of the reward token (integers as strings).
 */

import { loadPointsConfig, type PointsEnv } from "./points-config";

export type RewardProgram = {
  /** Stable id, lower case letters, digits and dashes. Stored with every epoch. */
  id: string;
  /** Short human label for the stage JSON, e.g. "QWAKK/QOR LP rewards". */
  label: string;
  /** Pool whose LPs earn. */
  poolId: string;
  /** Bank denom paid out by the contract. */
  rewardDenom: string;
  rewardSymbol: string;
  rewardDecimals: number;
  /** Reward budget per epoch in base units of rewardDenom. */
  epochBudget: bigint;
  /** Start of epoch 1 (UTC). */
  anchorMs: number;
  /** Epoch length in seconds (7 days by default). */
  epochSeconds: number;
  /** Claims of an epoch open when it ends and stay open this many days (the contract's stage start and end). */
  claimDays: number;
};

export type RewardsConfig = {
  /** Public API on (QWAKK_REWARDS_ENABLED). Off by default. */
  enabled: boolean;
  programs: RewardProgram[];
  /**
   * Addresses that never earn: the built-in owner, deployer and drill
   * accounts, QWAKK_REWARDS_EXCLUDED_ADDRESSES, the points exclusions
   * (QWAKK_POINTS_EXCLUDED_ADDRESSES, treasury, past treasuries) and the
   * manual points bot list (QWAKK_POINTS_BOT_ADDRESSES). Lower case, sorted.
   */
  excludedAddresses: string[];
  /** Also exclude the points program's automatic bot flags (QWAKK_REWARDS_EXCLUDE_POINTS_FLAGS, off by default). */
  excludePointsFlags: boolean;
  /** A holding streak must last this many hours before any of it earns. */
  minHoldHours: number;
  /** Longest gap between two LP snapshots still credited, in hours. */
  maxGapHours: number;
  /** Snapshots this many hours before an epoch are read, so a streak that began earlier is recognized. */
  lookbackHours: number;
  /** Reward contract address, stored with every finalized epoch. Optional until the contract is deployed. */
  contractAddress: string | null;
};

/**
 * Always excluded: the owner and treasury LP wallet (holds most of pool 6),
 * the token deployer and the retired Q-Day drill account. Testnet addresses.
 */
export const BUILT_IN_REWARD_EXCLUSIONS = [
  "qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq",
  "qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp",
  "qor12zrefy7keevrgyfamu4qgtmy85wq0n8cxrd3s3",
] as const;

export const DEFAULT_EPOCH_SECONDS = 7 * 86_400;
export const DEFAULT_CLAIM_DAYS = 30;
const ADDRESS_PATTERN = /^qor1[0-9a-z]{20,}$/;
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const DIGITS = /^\d+$/;
const MAX_U128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const HOUR_MS = 3_600_000;

function toggle(value: string | undefined, fallback: boolean) {
  const text = value?.trim().toLowerCase() ?? "";
  if (!text) return fallback;
  if (["enabled", "true", "1", "on"].includes(text)) return true;
  if (["disabled", "false", "0", "off"].includes(text)) return false;
  return fallback;
}

function addressList(value: string | undefined) {
  return (value ?? "").split(/[\s,]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => ADDRESS_PATTERN.test(entry));
}

function integerSetting(env: PointsEnv, name: string, fallback: number, min: number, max: number, warnings: string[]) {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = DIGITS.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    warnings.push(`${name} must be an integer between ${min} and ${max}, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Parses one program entry. Returns null and a warning when it is unusable: a broken program must never pay out. */
function parseProgram(raw: unknown, index: number, warnings: string[]): RewardProgram | null {
  const where = `QWAKK_REWARDS_PROGRAMS[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${where} is not an object, skipped`);
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string).trim() : typeof entry[key] === "number" ? String(entry[key]) : "");
  const id = text("id");
  const poolId = text("poolId");
  const rewardDenom = text("denom");
  const rewardSymbol = text("symbol") || rewardDenom;
  const decimalsText = text("decimals");
  const budgetText = text("epochBudget");
  const anchorText = text("anchor");
  const epochDaysText = text("epochDays") || "7";
  const claimDaysText = text("claimDays") || String(DEFAULT_CLAIM_DAYS);
  const problems: string[] = [];
  if (!ID_PATTERN.test(id)) problems.push("id must be 1 to 40 lower case letters, digits or dashes");
  if (!DIGITS.test(poolId)) problems.push("poolId must be a pool number");
  if (!rewardDenom || rewardDenom.length > 128 || /\s/.test(rewardDenom)) problems.push("denom is required");
  const decimals = DIGITS.test(decimalsText) ? Number(decimalsText) : Number.NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) problems.push("decimals must be 0 to 18");
  // Budgets come as a string of base units; a JSON number above 2^53 would already have lost precision.
  if (typeof entry.epochBudget === "number" && !Number.isSafeInteger(entry.epochBudget)) problems.push("epochBudget must be a string of base units");
  const budget = DIGITS.test(budgetText) ? BigInt(budgetText) : null;
  if (budget === null || budget <= BigInt(0) || budget > MAX_U128) problems.push("epochBudget must be a positive integer of base units");
  // An explicit UTC offset is required, so the anchor never depends on the server time zone.
  const anchorMs = /(Z|[+-]\d{2}:\d{2})$/.test(anchorText) ? Date.parse(anchorText) : Number.NaN;
  if (!Number.isFinite(anchorMs)) problems.push("anchor must be an ISO time with a time zone, e.g. 2026-11-27T00:00:00Z");
  const epochDays = DIGITS.test(epochDaysText) ? Number(epochDaysText) : Number.NaN;
  if (!Number.isInteger(epochDays) || epochDays < 1 || epochDays > 28) problems.push("epochDays must be 1 to 28");
  const claimDays = DIGITS.test(claimDaysText) ? Number(claimDaysText) : Number.NaN;
  if (!Number.isInteger(claimDays) || claimDays < 1 || claimDays > 365) problems.push("claimDays must be 1 to 365");
  if (problems.length) {
    warnings.push(`${where} skipped: ${problems.join("; ")}`);
    return null;
  }
  const label = text("label").slice(0, 80) || `${rewardSymbol} LP rewards, pool ${poolId}`;
  return { id, label, poolId, rewardDenom, rewardSymbol: rewardSymbol.slice(0, 20), rewardDecimals: decimals, epochBudget: budget as bigint, anchorMs, epochSeconds: epochDays * 86_400, claimDays };
}

export function loadRewardsConfig(env: PointsEnv = process.env): { config: RewardsConfig; warnings: string[] } {
  const warnings: string[] = [];
  const { config: points } = loadPointsConfig(env);

  const programs: RewardProgram[] = [];
  const rawPrograms = env.QWAKK_REWARDS_PROGRAMS?.trim();
  if (rawPrograms) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawPrograms);
    } catch {
      warnings.push("QWAKK_REWARDS_PROGRAMS is not valid JSON, no program is active");
    }
    if (parsed !== null && !Array.isArray(parsed)) warnings.push("QWAKK_REWARDS_PROGRAMS must be a JSON array, no program is active");
    if (Array.isArray(parsed)) {
      parsed.forEach((raw, index) => {
        const program = parseProgram(raw, index, warnings);
        if (!program) return;
        if (programs.some((existing) => existing.id === program.id)) {
          warnings.push(`QWAKK_REWARDS_PROGRAMS has the id ${program.id} twice, the later one is skipped`);
          return;
        }
        programs.push(program);
      });
    }
  }

  const contract = env.QWAKK_REWARDS_CONTRACT_ADDRESS?.trim().toLowerCase() ?? "";
  if (contract && !ADDRESS_PATTERN.test(contract)) warnings.push("QWAKK_REWARDS_CONTRACT_ADDRESS is not a qor1 address, it is ignored");

  const excludedAddresses = [...new Set([
    ...BUILT_IN_REWARD_EXCLUSIONS,
    ...addressList(env.QWAKK_REWARDS_EXCLUDED_ADDRESSES),
    ...points.excludedAddresses,
    ...points.botAddresses,
  ])].sort();

  const minHoldHours = integerSetting(env, "QWAKK_REWARDS_MIN_HOLD_HOURS", points.lpMinHoldHours, 1, 24 * 7, warnings);
  const maxGapHours = integerSetting(env, "QWAKK_REWARDS_MAX_GAP_HOURS", points.lpMaxIntervalHours, 1, 48, warnings);
  const config: RewardsConfig = {
    enabled: toggle(env.QWAKK_REWARDS_ENABLED, false),
    programs,
    excludedAddresses,
    excludePointsFlags: toggle(env.QWAKK_REWARDS_EXCLUDE_POINTS_FLAGS, false),
    minHoldHours,
    maxGapHours,
    lookbackHours: minHoldHours + maxGapHours + 24,
    contractAddress: contract && ADDRESS_PATTERN.test(contract) ? contract : null,
  };
  if (config.enabled && !programs.length) warnings.push("QWAKK_REWARDS_ENABLED is on but no valid program is configured");
  return { config, warnings };
}

export type EpochWindow = { number: number; startMs: number; endMs: number };

/** Window of epoch `number` (1 based). */
export function epochWindow(program: Pick<RewardProgram, "anchorMs" | "epochSeconds">, number: number): EpochWindow {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Epoch numbers start at 1");
  const startMs = program.anchorMs + (number - 1) * program.epochSeconds * 1000;
  return { number, startMs, endMs: startMs + program.epochSeconds * 1000 };
}

/** The epoch running at `nowMs`, or null before the anchor. */
export function epochAt(program: Pick<RewardProgram, "anchorMs" | "epochSeconds">, nowMs: number): EpochWindow | null {
  if (nowMs < program.anchorMs) return null;
  return epochWindow(program, Math.floor((nowMs - program.anchorMs) / (program.epochSeconds * 1000)) + 1);
}

/**
 * An epoch can be finalized once no snapshot that its computation reads can
 * still be written: snapshots are written only for the current UTC hour, and
 * the computation reads up to `maxGapHours` past the end.
 */
export function epochSettlesAt(window: EpochWindow, maxGapHours: number) {
  return window.endMs + (maxGapHours + 1) * HOUR_MS;
}

/** Plain JSON view of a program, for logs and the API. */
export function describeProgram(program: RewardProgram) {
  return { ...program, epochBudget: program.epochBudget.toString(), anchor: new Date(program.anchorMs).toISOString() };
}

/** Claims of an epoch open when it ends and close `claimDays` later. Deterministic, so a repeated finalize prints the same JSON. */
export function claimWindow(program: Pick<RewardProgram, "claimDays">, window: EpochWindow) {
  return { startMs: window.endMs, endMs: window.endMs + program.claimDays * 86_400_000 };
}

/**
 * The stage JSON handed to the rewards contract CLI (register_stage). start
 * and end are the claim window in unix seconds, as the contract's
 * RegisterStage expects (claims allowed in [start, end); it refuses an end in
 * the past). The epoch's own window is in the label. total is the u128 sum of
 * the stage's claims in base units of `denom`.
 */
export function stageJson(input: { stageId: bigint; root: string; total: bigint; program: RewardProgram; window: EpochWindow }) {
  const claims = claimWindow(input.program, input.window);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    stage_id: Number(input.stageId),
    root: input.root,
    total: input.total.toString(),
    denom: input.program.rewardDenom,
    pool_id: Number(input.program.poolId),
    start: Math.floor(claims.startMs / 1000),
    end: Math.floor(claims.endMs / 1000),
    label: `${input.program.label}, epoch ${input.window.number} (${day(input.window.startMs)} to ${day(input.window.endMs)})`.slice(0, 128),
  };
}
