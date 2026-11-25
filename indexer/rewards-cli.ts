/**
 * Owner tool for Qwakk liquidity rewards. It never signs or broadcasts
 * anything: it computes epochs from indexed data, writes allocations and
 * proofs, and prints the stage JSON the rewards contract CLI registers.
 *
 * Usage, from qwakk-app (in the indexer container: node --import tsx indexer/rewards-cli.ts ...):
 *   npm run rewards -- status
 *   npm run rewards -- preview  --program <id> [--epoch <n>]          shares and amounts, writes nothing (default: the running epoch)
 *   npm run rewards -- finalize --program <id> --epoch <n> --stage-id <s>                 dry run
 *   npm run rewards -- finalize --program <id> --epoch <n> --stage-id <s> --apply [--out stage.json] [--replace]
 *   npm run rewards -- verify   --program <id> --epoch <n>          recompute with the frozen rules, compare the root
 *   npm run rewards -- mark-registered --program <id> --epoch <n> --stage-id <s> [--tx <hash>]
 *
 * Flow per epoch: wait until `status` says the epoch is settled, run finalize
 * as a dry run, then finalize --apply with the stage id the contract will
 * assign next (its last stage + 1: the stage id is part of every leaf), give
 * the stage JSON to the contract CLI's register_stage, and finally run
 * mark-registered. A finalized epoch can be replaced (--replace) until it is
 * registered, e.g. when the stage id turned out different; a registered epoch
 * is never rewritten.
 *
 * Reads DATABASE_URL and the QWAKK_REWARDS_* settings like the indexer.
 * QWAKK_NETWORK must match the database's chain id (see rebuild-candles.ts).
 */
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";

import { databaseNetworkCheck, resolveIndexerNetwork } from "./indexer-config";
import { loadPointsConfig } from "./points-config";
import { claimWindow, describeProgram, epochAt, epochSettlesAt, epochWindow, loadRewardsConfig, stageJson, type RewardProgram, type RewardsConfig } from "./rewards-config";
import { computeEpoch, rewardExclusions, rulesFromConfig, syncRewardPrograms, type EpochRules } from "./rewards-data";
import { buildRewardTree, verifyRewardProof } from "./rewards-merkle";
import { formatUnits, sharePpm } from "./rewards-math";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://qwakk:qwakk_local@localhost:5438/qwakk";
const DIGITS = /^\d+$/;

type Args = { command: string; flags: Map<string, string | true> };

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key.slice(2), next);
      index += 1;
    } else {
      flags.set(key.slice(2), true);
    }
  }
  return { command, flags };
}

function text(args: Args, name: string) {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

function positive(args: Args, name: string, required: boolean) {
  const value = text(args, name);
  if (value === null) {
    if (required) throw new Error(`--${name} <number> is required`);
    return null;
  }
  if (!DIGITS.test(value) || BigInt(value) < BigInt(1)) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function programFrom(config: RewardsConfig, args: Args) {
  const id = text(args, "program") ?? (config.programs.length === 1 ? config.programs[0].id : null);
  if (!id) throw new Error(`--program <id> is required (${config.programs.map((program) => program.id).join(", ") || "no program configured"})`);
  const program = config.programs.find((entry) => entry.id === id);
  if (!program) throw new Error(`Program ${id} is not in QWAKK_REWARDS_PROGRAMS`);
  return program;
}

function percent(part: bigint, total: bigint) {
  return `${formatUnits(sharePpm(part, total), 4)}%`;
}

type EpochRow = {
  status: string;
  stage_id: string | null;
  merkle_root: string | null;
  contract_address: string | null;
  budget: string;
  starts_at: Date;
  ends_at: Date;
  total_allocated: string | null;
  config: { excluded?: string[]; minHoldHours?: number; maxGapHours?: number; lookbackHours?: number };
};

async function epochRow(db: Pool, programId: string, epoch: number) {
  return (await db.query<EpochRow>(
    `SELECT status, stage_id::text, merkle_root, contract_address, budget::text, starts_at, ends_at, total_allocated::text, config
     FROM reward_epochs WHERE program_id = $1 AND epoch_number = $2`,
    [programId, epoch],
  )).rows[0] ?? null;
}

function frozenRules(row: EpochRow): EpochRules {
  const config = row.config;
  if (!Array.isArray(config.excluded) || !config.minHoldHours || !config.maxGapHours || !config.lookbackHours) throw new Error("The stored epoch has no frozen rules");
  return { excluded: config.excluded, minHoldHours: config.minHoldHours, maxGapHours: config.maxGapHours, lookbackHours: config.lookbackHours };
}

function printAllocations(program: RewardProgram, result: Awaited<ReturnType<typeof computeEpoch>>, limit = 50) {
  const { allocation, computation } = result;
  console.log(`Eligible share-seconds ${computation.totalShareSeconds}, excluded share-seconds ${computation.excludedShareSeconds}`);
  console.log(`Recipients ${allocation.allocations.length}, allocated ${allocation.total} (${formatUnits(allocation.total, program.rewardDecimals)} ${program.rewardSymbol}), dust ${allocation.dust}`);
  for (const entry of allocation.allocations.slice().sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1)).slice(0, limit)) {
    console.log(`  ${entry.address}  ${percent(entry.shareSeconds, allocation.totalShareSeconds).padStart(9)}  ${formatUnits(entry.amount, program.rewardDecimals)} ${program.rewardSymbol}`);
  }
  if (allocation.allocations.length > limit) console.log(`  ... ${allocation.allocations.length - limit} more`);
  if (computation.warmingUp.size) console.log(`Still inside the minimum hold at the end of the data: ${[...computation.warmingUp.keys()].join(", ")}`);
}

async function status(db: Pool, config: RewardsConfig) {
  const now = Date.now();
  console.log(`Public API ${config.enabled ? "on" : "off"} (QWAKK_REWARDS_ENABLED). Minimum hold ${config.minHoldHours} h, longest credited gap ${config.maxGapHours} h.`);
  console.log(`Excluded: ${config.excludedAddresses.join(", ")}${config.excludePointsFlags ? " plus the points bot flags" : ""}`);
  for (const program of config.programs) {
    console.log(`\n${JSON.stringify(describeProgram(program))}`);
    const rows = await db.query<{ epoch_number: number; status: string; stage_id: string | null; merkle_root: string | null; total_allocated: string | null; recipients: number | null }>(
      "SELECT epoch_number, status, stage_id::text, merkle_root, total_allocated::text, recipients FROM reward_epochs WHERE program_id = $1",
      [program.id],
    );
    const stored = new Map(rows.rows.map((row) => [row.epoch_number, row]));
    const current = epochAt(program, now);
    const last = current?.number ?? 0;
    for (let number = 1; number <= last; number += 1) {
      const window = epochWindow(program, number);
      const row = stored.get(number);
      const settles = epochSettlesAt(window, config.maxGapHours);
      const state = row
        ? `${row.status}, stage ${row.stage_id}, root ${row.merkle_root}, ${row.recipients} recipients, ${row.total_allocated} allocated`
        : number === last ? "running" : now >= settles ? "settled, ready to finalize" : `closed, settles at ${new Date(settles).toISOString()}`;
      console.log(`  epoch ${number}  ${new Date(window.startMs).toISOString()} to ${new Date(window.endMs).toISOString()}  ${state}`);
    }
    if (!current) console.log(`  epoch 1 starts at ${new Date(program.anchorMs).toISOString()}`);
  }
}

async function finalize(db: Pool, config: RewardsConfig, program: RewardProgram, args: Args, pointsSeason: string) {
  const epoch = Number(positive(args, "epoch", true));
  const stageId = BigInt(positive(args, "stage-id", true) as string);
  const apply = args.flags.has("apply");
  const replace = args.flags.has("replace");
  const out = text(args, "out");
  if (out && !apply) throw new Error("--out is written only with --apply, so an unsaved tree is never registered");
  const window = epochWindow(program, epoch);
  const existing = await epochRow(db, program.id, epoch);

  // An existing epoch is recomputed with its frozen rules: identical means a harmless repeat.
  if (existing && (existing.starts_at.getTime() !== window.startMs || existing.ends_at.getTime() !== window.endMs)) {
    throw new Error("The configured epoch window no longer matches the stored one (anchor or length changed)");
  }
  if (existing && !(replace && existing.status !== "registered")) {
    const result = await computeEpoch(db, program, window, frozenRules(existing), BigInt(existing.budget), Date.now());
    const tree = result.allocation.allocations.length ? buildRewardTree(BigInt(existing.stage_id as string), result.allocation.allocations) : null;
    const same = tree !== null && tree.root === existing.merkle_root && existing.stage_id === stageId.toString();
    if (!same) {
      throw new Error(existing.status === "registered"
        ? `Epoch ${epoch} is registered as stage ${existing.stage_id} with root ${existing.merkle_root}; it is never rewritten`
        : `Epoch ${epoch} is already finalized as stage ${existing.stage_id} with root ${existing.merkle_root}. Add --replace to rewrite it (only before it is registered)`);
    }
    const json = stageJson({ stageId, root: tree.root, total: BigInt(existing.total_allocated ?? "0"), program, window });
    console.log(`Epoch ${epoch} is already ${existing.status} with the same root.`);
    if (out) await writeFile(out, `${JSON.stringify(json, null, 2)}\n`);
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const rules = rulesFromConfig(config, await rewardExclusions(db, config, pointsSeason));
  const result = await computeEpoch(db, program, window, rules, program.epochBudget, Date.now());
  if (!result.settled) throw new Error(`Epoch ${epoch} cannot be finalized yet: ${result.notSettledReason}`);
  printAllocations(program, result);
  if (!result.allocation.allocations.length) throw new Error(`Epoch ${epoch} has no eligible liquidity, there is nothing to register`);
  const tree = buildRewardTree(stageId, result.allocation.allocations);
  for (const claim of tree.claims) if (!verifyRewardProof(claim.leaf, claim.proof, tree.root)) throw new Error(`Proof self check failed for ${claim.address}`);

  const contract = config.contractAddress;
  const clash = await db.query<{ program_id: string; epoch_number: number }>(
    "SELECT program_id, epoch_number FROM reward_epochs WHERE COALESCE(contract_address, '') = $1 AND stage_id = $2 AND NOT (program_id = $3 AND epoch_number = $4)",
    [contract ?? "", stageId.toString(), program.id, epoch],
  );
  if (clash.rowCount) throw new Error(`Stage ${stageId} already belongs to ${clash.rows[0].program_id} epoch ${clash.rows[0].epoch_number}`);
  const highest = (await db.query<{ max: string | null }>("SELECT MAX(stage_id)::text AS max FROM reward_epochs WHERE COALESCE(contract_address, '') = $1", [contract ?? ""])).rows[0]?.max;
  const expected = BigInt(highest ?? "0") + BigInt(1);
  if (stageId !== expected) console.warn(`Note: the next stage id after the stored epochs is ${expected}. Use the id the contract assigns at register time.`);

  const json = stageJson({ stageId, root: tree.root, total: result.allocation.total, program, window });
  const claims = claimWindow(program, window);
  console.log(`Root ${tree.root} for stage ${stageId}, claims open ${new Date(claims.startMs).toISOString()} to ${new Date(claims.endMs).toISOString()}`);
  // The contract refuses a stage whose claim window already ended; leave an hour to register it.
  if (claims.endMs <= Date.now() + 3_600_000) throw new Error("The claim window of this epoch is over or about to end. Raise claimDays for the program to finalize it");
  if (!apply) {
    console.log("Dry run only. Add --apply to write the allocations and proofs.");
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const frozen = { ...rules, budget: program.epochBudget.toString(), rewardDecimals: program.rewardDecimals, rewardSymbol: program.rewardSymbol };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query<{ status: string }>("SELECT status FROM reward_epochs WHERE program_id = $1 AND epoch_number = $2 FOR UPDATE", [program.id, epoch])).rows[0];
    if (locked?.status === "registered") throw new Error(`Epoch ${epoch} was registered meanwhile; it is never rewritten`);
    await client.query("DELETE FROM reward_allocations WHERE program_id = $1 AND epoch_number = $2", [program.id, epoch]);
    await client.query(
      `INSERT INTO reward_epochs (program_id, epoch_number, pool_id, reward_denom, starts_at, ends_at, budget, status, contract_address, stage_id, merkle_root,
         total_allocated, dust, recipients, total_share_seconds, excluded_share_seconds, data_through_height, config, claim_starts_at, claim_ends_at, finalized_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'finalized', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
       ON CONFLICT (program_id, epoch_number) DO UPDATE SET pool_id = EXCLUDED.pool_id, reward_denom = EXCLUDED.reward_denom, starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at, budget = EXCLUDED.budget, status = 'finalized', contract_address = EXCLUDED.contract_address, stage_id = EXCLUDED.stage_id,
         merkle_root = EXCLUDED.merkle_root, total_allocated = EXCLUDED.total_allocated, dust = EXCLUDED.dust, recipients = EXCLUDED.recipients,
         total_share_seconds = EXCLUDED.total_share_seconds, excluded_share_seconds = EXCLUDED.excluded_share_seconds,
         data_through_height = EXCLUDED.data_through_height, config = EXCLUDED.config, claim_starts_at = EXCLUDED.claim_starts_at,
         claim_ends_at = EXCLUDED.claim_ends_at, finalized_at = NOW(), registered_at = NULL, register_tx_hash = NULL`,
      [program.id, epoch, program.poolId, program.rewardDenom, new Date(window.startMs), new Date(window.endMs), program.epochBudget.toString(), contract,
        stageId.toString(), tree.root, result.allocation.total.toString(), result.allocation.dust.toString(), tree.claims.length,
        result.computation.totalShareSeconds.toString(), result.computation.excludedShareSeconds.toString(), result.dataThroughHeight, JSON.stringify(frozen),
        new Date(claims.startMs), new Date(claims.endMs)],
    );
    const shares = new Map(result.allocation.allocations.map((entry) => [entry.address, entry.shareSeconds]));
    for (const claim of tree.claims) {
      await client.query(
        "INSERT INTO reward_allocations (program_id, epoch_number, address, share_seconds, amount, leaf, proof) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [program.id, epoch, claim.address, (shares.get(claim.address) as bigint).toString(), claim.amount.toString(), claim.leaf, claim.proof],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (out) await writeFile(out, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`Epoch ${epoch} finalized as stage ${stageId}.${out ? ` Stage JSON written to ${out}.` : ""}`);
  console.log(JSON.stringify(json, null, 2));
}

async function verify(db: Pool, program: RewardProgram, args: Args) {
  const epoch = Number(positive(args, "epoch", true));
  const row = await epochRow(db, program.id, epoch);
  if (!row || !row.stage_id || !row.merkle_root) throw new Error(`Epoch ${epoch} is not finalized`);
  const window = epochWindow(program, epoch);
  if (row.starts_at.getTime() !== window.startMs || row.ends_at.getTime() !== window.endMs) throw new Error("The configured epoch window no longer matches the stored one (anchor or length changed)");
  const result = await computeEpoch(db, program, window, frozenRules(row), BigInt(row.budget), Date.now());
  const tree = result.allocation.allocations.length ? buildRewardTree(BigInt(row.stage_id), result.allocation.allocations) : null;
  const stored = await db.query<{ address: string; amount: string; leaf: string; proof: string[] }>(
    "SELECT address, amount::text, leaf, proof FROM reward_allocations WHERE program_id = $1 AND epoch_number = $2 ORDER BY address",
    [program.id, epoch],
  );
  const bad = stored.rows.filter((claim) => !verifyRewardProof(claim.leaf, claim.proof, row.merkle_root as string));
  console.log(`Stored root   ${row.merkle_root}`);
  console.log(`Recomputed    ${tree?.root ?? "none"}`);
  console.log(`Stored proofs ${stored.rowCount} (${bad.length} failing)`);
  if (tree?.root !== row.merkle_root || bad.length) {
    process.exitCode = 1;
    console.error("Mismatch. Raw data for this epoch changed (late ingestion or pruned snapshots).");
  } else {
    console.log("Match.");
  }
}

async function markRegistered(db: Pool, program: RewardProgram, args: Args) {
  const epoch = Number(positive(args, "epoch", true));
  const stageId = positive(args, "stage-id", true) as string;
  const tx = text(args, "tx");
  if (tx !== null && !/^[0-9A-Fa-f]{64}$/.test(tx)) throw new Error("--tx must be a 64 character transaction hash");
  const result = await db.query(
    `UPDATE reward_epochs SET status = 'registered', registered_at = NOW(), register_tx_hash = $4
     WHERE program_id = $1 AND epoch_number = $2 AND stage_id = $3 AND status = 'finalized'`,
    [program.id, epoch, stageId, tx?.toUpperCase() ?? null],
  );
  if (!result.rowCount) throw new Error(`Epoch ${epoch} is not finalized as stage ${stageId}, or it is already registered`);
  console.log(`Epoch ${epoch} marked registered as stage ${stageId}.`);
}

async function preview(db: Pool, config: RewardsConfig, program: RewardProgram, args: Args, pointsSeason: string) {
  const now = Date.now();
  const epochText = positive(args, "epoch", false);
  const window = epochText ? epochWindow(program, Number(epochText)) : epochAt(program, now);
  if (!window) throw new Error(`Epoch 1 starts at ${new Date(program.anchorMs).toISOString()}`);
  const rules = rulesFromConfig(config, await rewardExclusions(db, config, pointsSeason));
  const result = await computeEpoch(db, program, window, rules, program.epochBudget, now, Math.min(now, window.endMs));
  console.log(`Epoch ${window.number} of ${program.id}: ${new Date(window.startMs).toISOString()} to ${new Date(window.endMs).toISOString()}, budget ${program.epochBudget}`);
  console.log(result.settled ? "Settled: this is the final result." : `Not final: ${result.notSettledReason ?? "the epoch is still running"}.`);
  printAllocations(program, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.flags.has("help")) {
    console.log("Commands: status, preview, finalize, verify, mark-registered. See the header of indexer/rewards-cli.ts.");
    return;
  }
  const { config, warnings } = loadRewardsConfig();
  for (const warning of warnings) console.warn(`Rewards config: ${warning}`);
  if (!config.programs.length) throw new Error("No rewards program is configured (QWAKK_REWARDS_PROGRAMS)");
  const pointsSeason = loadPointsConfig().config.season;
  const { network } = resolveIndexerNetwork(process.env);
  const db = new Pool({ connectionString: DATABASE_URL });
  try {
    const stored = (await db.query<{ value: string }>("SELECT value FROM indexer_state WHERE key = 'chain_id'")).rows[0]?.value ?? null;
    const check = databaseNetworkCheck({ configured: network.chainId, stored, assumed: text(args, "assume-chain-id") });
    if (!check.ok) throw new Error(check.reason);
    // The indexer applies the schema on start; the tables may still be missing if it has not restarted since.
    const ready = (await db.query<{ ready: boolean }>("SELECT to_regclass('reward_epochs') IS NOT NULL AS ready")).rows[0]?.ready;
    if (!ready) throw new Error("The reward tables do not exist yet. Restart the indexer once so it applies schema.sql");
    await syncRewardPrograms(db, config);
    if (args.command === "status") return await status(db, config);
    const program = programFrom(config, args);
    if (args.command === "preview") return await preview(db, config, program, args, pointsSeason);
    if (args.command === "finalize") return await finalize(db, config, program, args, pointsSeason);
    if (args.command === "verify") return await verify(db, program, args);
    if (args.command === "mark-registered") return await markRegistered(db, program, args);
    throw new Error(`Unknown command ${args.command}`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Rewards:", error instanceof Error ? error.message : error);
  process.exit(1);
});
