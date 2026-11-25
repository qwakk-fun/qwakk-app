import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BUILT_IN_REWARD_EXCLUSIONS, claimWindow, epochAt, epochSettlesAt, epochWindow, loadRewardsConfig, stageJson, truncateUtf8, type RewardProgram } from "../indexer/rewards-config";
import { allocateRewards, computeShareSeconds, formatUnits, sharePpm, type RewardRemoval, type RewardSnapshot, type ShareParams } from "../indexer/rewards-math";
import { buildRewardTree, hashPair, rewardLeaf, verifyRewardProof } from "../indexer/rewards-merkle";

type Vector = { stage: number; root: string; claims: Array<{ address: string; amount: string; leaf: string; proof: string[] }> };
const vector = JSON.parse(readFileSync(new URL("./fixtures/qwakk-rewards-vector.json", import.meta.url), "utf8")) as Vector;

const addr = (name: string) => `qor1${name.padEnd(38, "q")}`;
const ALICE = addr("alice");
const BOB = addr("bob");
const CAROL = addr("carol");
const GAMER = addr("gamer");
const OWNER = addr("owner");

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-27T00:00:00Z");
const hourAt = (hours: number) => T0 + hours * HOUR;
/** One block every 5 seconds from height 1000 at T0; a snapshot is read a minute into its hour. */
const heightAt = (ms: number) => 1000 + Math.floor((ms - T0) / 5000);
const snapHeight = (hours: number) => heightAt(hourAt(hours)) + 12;

function holding(address: string, fromHour: number, toHour: number, balance: (hour: number) => bigint | number): RewardSnapshot[] {
  const list: RewardSnapshot[] = [];
  for (let hour = fromHour; hour <= toHour; hour += 1) list.push({ address, hourMs: hourAt(hour), height: snapHeight(hour), lpBalance: BigInt(balance(hour)).toString() });
  return list;
}

const DAY_WINDOW: ShareParams = { startMs: hourAt(0), endMs: hourAt(24), minHoldHours: 6, maxGapHours: 3, excluded: [] };

test("Merkle tree matches the shared contract vector byte for byte", () => {
  for (const claim of vector.claims) {
    assert.equal(rewardLeaf(vector.stage, claim.address, BigInt(claim.amount)).toString("hex"), claim.leaf);
  }
  const tree = buildRewardTree(vector.stage, vector.claims.map((claim) => ({ address: claim.address, amount: BigInt(claim.amount) })));
  assert.equal(tree.root, "a546da3d30ca80c9abe13be629e99630e0baac67f8a8ac1616c347d044eeacac");
  assert.equal(tree.root, vector.root);
  tree.claims.forEach((claim, index) => {
    assert.equal(claim.leaf, vector.claims[index].leaf);
    assert.deepEqual(claim.proof, vector.claims[index].proof);
    assert.ok(verifyRewardProof(claim.leaf, claim.proof, tree.root));
  });
});

test("Merkle proofs reject a changed amount, stage or root and do not depend on input order", () => {
  const claims = vector.claims.map((claim) => ({ address: claim.address, amount: BigInt(claim.amount) }));
  const reversed = buildRewardTree(vector.stage, [...claims].reverse());
  assert.equal(reversed.root, vector.root);
  const [first] = vector.claims;
  assert.equal(verifyRewardProof(rewardLeaf(vector.stage, first.address, BigInt(first.amount) + BigInt(1)).toString("hex"), first.proof, vector.root), false);
  assert.equal(verifyRewardProof(rewardLeaf(2, first.address, BigInt(first.amount)).toString("hex"), first.proof, vector.root), false);
  assert.equal(verifyRewardProof(first.leaf, first.proof, "00".repeat(32)), false);
  assert.equal(verifyRewardProof(first.leaf, ["zz"], vector.root), false);
  // A different stage gives a different root for the same claims.
  assert.notEqual(buildRewardTree(2, claims).root, vector.root);
});

test("Merkle edge cases: one leaf, odd carry at several levels, sorted pairs, bounds", () => {
  const single = buildRewardTree(7, [{ address: ALICE, amount: BigInt(5) }]);
  assert.equal(single.root, rewardLeaf(7, ALICE, BigInt(5)).toString("hex"));
  assert.deepEqual(single.claims[0].proof, []);

  const five = buildRewardTree(3, [ALICE, BOB, CAROL, GAMER, OWNER].map((address, index) => ({ address, amount: BigInt(index + 1) })));
  for (const claim of five.claims) assert.ok(verifyRewardProof(claim.leaf, claim.proof, five.root));
  // The carried fifth leaf skips the levels where it had no sibling.
  assert.ok(five.claims.some((claim) => claim.proof.length === 1));

  const a = rewardLeaf(1, ALICE, BigInt(1));
  const b = rewardLeaf(1, BOB, BigInt(1));
  assert.deepEqual(hashPair(a, b), hashPair(b, a));

  assert.throws(() => rewardLeaf(0, ALICE, BigInt(1)));
  assert.throws(() => rewardLeaf(1, ALICE, BigInt(1) << BigInt(128)));
  assert.doesNotThrow(() => rewardLeaf(1, ALICE, (BigInt(1) << BigInt(128)) - BigInt(1)));
  assert.throws(() => buildRewardTree(1, []));
  assert.throws(() => buildRewardTree(1, [{ address: ALICE, amount: BigInt(1) }, { address: ALICE, amount: BigInt(2) }]));
});

test("share-seconds weight LP units by time, and excluded holders do not dilute others", () => {
  const snapshots = [
    ...holding(ALICE, -10, 27, () => 100),
    ...holding(BOB, -10, 27, () => 300),
    ...holding(OWNER, -10, 27, () => 9000),
  ];
  const result = computeShareSeconds(snapshots, [], { ...DAY_WINDOW, excluded: [OWNER] });
  const day = BigInt(24 * 3600);
  assert.deepEqual(result.eligible, [
    { address: ALICE, shareSeconds: BigInt(100) * day },
    { address: BOB, shareSeconds: BigInt(300) * day },
  ]);
  assert.equal(result.totalShareSeconds, BigInt(400) * day);
  assert.equal(result.excludedShareSeconds, BigInt(9000) * day);

  const allocation = allocateRewards(BigInt(1000), result.eligible);
  assert.deepEqual(allocation.allocations.map((entry) => [entry.address, entry.amount]), [[ALICE, BigInt(250)], [BOB, BigInt(750)]]);
  assert.equal(allocation.dust, BigInt(0));
});

test("add then remove inside the minimum hold earns nothing, every unit earns only after its own warm-up", () => {
  // Holds from hour 10 to hour 13: never passes the 6 hour minimum.
  const gamer = holding(GAMER, 8, 16, (hour) => (hour >= 10 && hour <= 13 ? 1_000_000 : 0));
  // Holds exactly 6 hours (10 to 16): all of it is warm-up.
  const brief = holding(BOB, 8, 20, (hour) => (hour >= 10 && hour <= 16 ? 1_000_000 : 0));
  // Holds from hour 10 to hour 20: earns the 4 hours after its warm-up (16 to 20).
  const carol = holding(CAROL, 8, 24, (hour) => (hour >= 10 && hour <= 20 ? 50 : 0));
  const result = computeShareSeconds([...gamer, ...brief, ...carol], [], DAY_WINDOW);
  assert.deepEqual(result.eligible, [{ address: CAROL, shareSeconds: BigInt(50 * 4 * 3600) }]);
  assert.equal(result.warmingUp.size, 0);
});

test("removals cut the credit at once, an add earns only after it has been held the minimum hold", () => {
  const snapshots = holding(ALICE, -10, 24, (hour) => (hour < 5 ? 100 : hour < 12 ? 40 : 90));
  const removals: RewardRemoval[] = [{ address: ALICE, height: snapHeight(4) + 100, lpAmount: "60" }];
  const result = computeShareSeconds(snapshots, removals, DAY_WINDOW);
  // Hours 0-4: 100. From the removal (hour 4-5) the trailing window holds 40, until hour 18,
  // when the 50 added in hour 11-12 (held from hour 12) has itself been held 6 hours: 90 from then on.
  const expected = (100 * 4 + 40 * 14 + 90 * 6) * 3600;
  assert.equal(result.eligible[0].shareSeconds, BigInt(expected));
});

test("a removal without an LP amount zeroes its interval and restarts the minimum hold", () => {
  const snapshots = holding(ALICE, -10, 24, (hour) => (hour < 10 ? 100 : 60));
  const removals: RewardRemoval[] = [{ address: ALICE, height: snapHeight(9) + 50, lpAmount: null }];
  const result = computeShareSeconds(snapshots, removals, DAY_WINDOW);
  // Hours 0-9 at 100, hour 9-10 nothing, hours 10-16 warm-up again, hours 16-24 at 60.
  assert.equal(result.eligible[0].shareSeconds, BigInt((100 * 9 + 60 * 8) * 3600));
});

test("credit is clipped to the epoch window, warm-up before the start counts toward the minimum hold", () => {
  // Held from 6 hours before the epoch: the warm-up is over at the start, the whole day earns.
  const early = computeShareSeconds(holding(ALICE, -6, 30, () => 10), [], DAY_WINDOW);
  assert.equal(early.eligible[0].shareSeconds, BigInt(10 * 24 * 3600));
  // Held from 3 hours before: the first 3 hours of the epoch are still warm-up.
  const late = computeShareSeconds(holding(ALICE, -3, 30, () => 10), [], DAY_WINDOW);
  assert.equal(late.eligible[0].shareSeconds, BigInt(10 * 21 * 3600));
});

test("a snapshot gap is credited for at most the longest gap", () => {
  const hours = [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 11, 12, 13, 14];
  const snapshots = hours.map((hour) => ({ address: ALICE, hourMs: hourAt(hour), height: snapHeight(hour), lpBalance: "10" }));
  const result = computeShareSeconds(snapshots, [], DAY_WINDOW);
  // 1 + 3 (capped from 10) + 1 + 1 + 1 = 7 hours.
  assert.equal(result.eligible[0].shareSeconds, BigInt(10 * 7 * 3600));
});

test("holding with nothing past the minimum hold yet is reported as warming up", () => {
  const snapshots = holding(BOB, 18, 22, () => 5);
  const result = computeShareSeconds(snapshots, [], DAY_WINDOW);
  assert.deepEqual(result.eligible, []);
  assert.equal(result.warmingUp.get(BOB), 4);
});

/** Reads the data the way finalize does: from lookback hours before the start to maxGap hours after the end. */
function finalizeEpoch(all: RewardSnapshot[], startHour: number, endHour: number) {
  const lookback = 6 + 3 + 24;
  const visible = all.filter((entry) => entry.hourMs >= hourAt(startHour - lookback) && entry.hourMs <= hourAt(endHour + 3));
  return computeShareSeconds(visible, [], { ...DAY_WINDOW, startMs: hourAt(startHour), endMs: hourAt(endHour) });
}

test("QA: liquidity added near an epoch end loses no credit across the boundary", () => {
  // Added 2 hours before the end of epoch 1 and held 12 hours: 6 hours of warm-up, then 6 hours earned in epoch 2.
  const lateAdd = holding(ALICE, 20, 40, (hour) => (hour >= 22 && hour <= 34 ? 10 : 0));
  const first = finalizeEpoch(lateAdd, 0, 24);
  const second = finalizeEpoch(lateAdd, 24, 48);
  assert.deepEqual(first.eligible, []);
  assert.equal(second.eligible[0].shareSeconds, BigInt(10 * 6 * 3600));

  // Added 8 hours before the end: 2 hours earned in epoch 1, 4 in epoch 2, the same 6 hours in total.
  const earlier = holding(BOB, 14, 40, (hour) => (hour >= 16 && hour <= 28 ? 10 : 0));
  const a = finalizeEpoch(earlier, 0, 24).eligible[0].shareSeconds;
  const b = finalizeEpoch(earlier, 24, 48).eligible[0].shareSeconds;
  assert.equal(a, BigInt(10 * 2 * 3600));
  assert.equal(b, BigInt(10 * 4 * 3600));
  // Splitting into epochs never changes the total.
  const whole = computeShareSeconds(earlier, [], { ...DAY_WINDOW, startMs: hourAt(0), endMs: hourAt(48) });
  assert.equal(a + b, whole.eligible[0].shareSeconds);
});

test("QA: a small primer position does not let a large deposit skip the minimum hold", () => {
  // 1 unit held all along; 1M added before hour 10, held across one snapshot hour, removed in hour 11-12.
  const primed = holding(GAMER, -10, 24, (hour) => (hour === 10 || hour === 11 ? 1_000_001 : 1));
  const removals: RewardRemoval[] = [{ address: GAMER, height: snapHeight(11) + 30, lpAmount: "1000000" }];
  const honest = holding(BOB, -10, 24, () => 1_000_000);
  const result = computeShareSeconds([...primed, ...honest], removals, DAY_WINDOW);
  assert.deepEqual(result.eligible, [
    { address: BOB, shareSeconds: BigInt(1_000_000 * 24 * 3600) },
    { address: GAMER, shareSeconds: BigInt(1 * 24 * 3600) },
  ]);
});

test("allocation floors every amount and reports the dust", () => {
  const equal = allocateRewards(BigInt(10), [{ address: ALICE, shareSeconds: BigInt(1) }, { address: BOB, shareSeconds: BigInt(1) }, { address: CAROL, shareSeconds: BigInt(1) }]);
  assert.deepEqual(equal.allocations.map((entry) => entry.amount), [BigInt(3), BigInt(3), BigInt(3)]);
  assert.equal(equal.total, BigInt(9));
  assert.equal(equal.dust, BigInt(1));

  const tiny = allocateRewards(BigInt(100), [{ address: ALICE, shareSeconds: BigInt(1) }, { address: BOB, shareSeconds: BigInt(1_000) }]);
  assert.deepEqual(tiny.allocations.map((entry) => entry.address), [BOB]);
  assert.equal(tiny.total + tiny.dust, BigInt(100));

  const none = allocateRewards(BigInt(500), []);
  assert.deepEqual(none.allocations, []);
  assert.equal(none.dust, BigInt(500));

  // Large budgets stay exact.
  const big = allocateRewards(BigInt("1000000000000000000000000"), [{ address: ALICE, shareSeconds: BigInt(2) }, { address: BOB, shareSeconds: BigInt(1) }]);
  assert.equal(big.allocations[0].amount, BigInt("666666666666666666666666"));
  assert.equal(big.dust, BigInt(1));
  assert.equal(sharePpm(BigInt(1), BigInt(3)), BigInt(333333));
  assert.equal(formatUnits(BigInt(1_500_000), 6), "1.5");
  assert.equal(formatUnits(BigInt(7), 6), "0.000007");
});

test("the same data in any order gives the same allocations and root", () => {
  const snapshots = [
    ...holding(ALICE, -5, 27, (hour) => 100 + hour),
    ...holding(BOB, -5, 27, () => 333),
    ...holding(CAROL, 2, 27, (hour) => (hour > 14 ? 0 : 77)),
    ...holding(GAMER, 10, 13, () => 1_000_000),
  ];
  const removals: RewardRemoval[] = [{ address: CAROL, height: snapHeight(14) + 30, lpAmount: "77" }];
  const run = (snapshotList: RewardSnapshot[], removalList: RewardRemoval[]) => {
    const shares = computeShareSeconds(snapshotList, removalList, DAY_WINDOW);
    const allocation = allocateRewards(BigInt(123_456_789), shares.eligible);
    return { allocation, root: buildRewardTree(4, allocation.allocations).root };
  };
  const first = run(snapshots, removals);
  const shuffled = run([...snapshots].reverse().map((entry) => ({ ...entry, address: entry.address.toUpperCase().replace("QOR1", "qor1") })), [...removals].reverse());
  assert.deepEqual(shuffled.allocation, first.allocation);
  assert.equal(shuffled.root, first.root);
  assert.equal(first.allocation.total + first.allocation.dust, BigInt(123_456_789));
});

const PROGRAM_JSON = JSON.stringify([{ id: "qwakk-lp", label: "QWAKK/QOR LP rewards", poolId: 6, denom: "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23", symbol: "QWAKK", decimals: 6, epochBudget: "1000000000", anchor: "2026-11-27T00:00:00Z" }]);

test("rewards config is off by default, reads programs from JSON and always excludes the built-in wallets", () => {
  const empty = loadRewardsConfig({});
  assert.equal(empty.config.enabled, false);
  assert.deepEqual(empty.config.programs, []);
  for (const address of BUILT_IN_REWARD_EXCLUSIONS) assert.ok(empty.config.excludedAddresses.includes(address));
  assert.equal(empty.config.minHoldHours, 6);
  assert.equal(empty.config.maxGapHours, 3);
  assert.equal(empty.config.excludePointsFlags, false);

  const { config, warnings } = loadRewardsConfig({
    QWAKK_REWARDS_ENABLED: "enabled",
    QWAKK_REWARDS_PROGRAMS: PROGRAM_JSON,
    QWAKK_REWARDS_EXCLUDED_ADDRESSES: `${ALICE}, not-an-address`,
    QWAKK_POINTS_EXCLUDED_ADDRESSES: BOB,
    QWAKK_POINTS_BOT_ADDRESSES: CAROL,
    QWAKK_REWARDS_MIN_HOLD_HOURS: "12",
  });
  assert.deepEqual(warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.minHoldHours, 12);
  const [program] = config.programs;
  assert.equal(program.poolId, "6");
  assert.equal(program.rewardDenom, "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23");
  assert.equal(program.epochBudget, BigInt(1_000_000_000));
  assert.equal(program.epochSeconds, 7 * 86_400);
  for (const address of [ALICE, BOB, CAROL]) assert.ok(config.excludedAddresses.includes(address));
});

test("a broken program is skipped with a warning, never half loaded", () => {
  const cases = [
    { epochBudget: "0" },
    { epochBudget: 12.5 },
    { epochBudget: 2 ** 60 },
    { anchor: "2026-11-27T00:00:00" },
    { poolId: "six" },
    { decimals: 30 },
    { id: "Bad Id" },
    { claimDays: 0 },
  ];
  for (const change of cases) {
    const base = JSON.parse(PROGRAM_JSON)[0];
    const { config, warnings } = loadRewardsConfig({ QWAKK_REWARDS_PROGRAMS: JSON.stringify([{ ...base, ...change }]) });
    assert.deepEqual(config.programs, [], JSON.stringify(change));
    assert.equal(warnings.length, 1);
  }
  assert.deepEqual(loadRewardsConfig({ QWAKK_REWARDS_PROGRAMS: "{" }).config.programs, []);
});

test("epoch windows follow the anchor and settle after the longest gap", () => {
  const program = loadRewardsConfig({ QWAKK_REWARDS_PROGRAMS: PROGRAM_JSON }).config.programs[0];
  assert.equal(epochAt(program, T0 - 1), null);
  assert.deepEqual(epochAt(program, T0), { number: 1, startMs: T0, endMs: T0 + 7 * 86_400_000 });
  assert.equal(epochAt(program, T0 + 7 * 86_400_000)?.number, 2);
  const second = epochWindow(program, 2);
  assert.equal(new Date(second.startMs).toISOString(), "2026-12-04T00:00:00.000Z");
  assert.equal(epochSettlesAt(second, 3), second.endMs + 4 * HOUR);
  assert.throws(() => epochWindow(program, 0));
});

test("stage JSON carries what register_stage needs: start and end are the claim window", () => {
  const program = loadRewardsConfig({ QWAKK_REWARDS_PROGRAMS: PROGRAM_JSON }).config.programs[0] as RewardProgram;
  assert.equal(program.claimDays, 30);
  const window = epochWindow(program, 1);
  const epochEnd = Math.floor(T0 / 1000) + 7 * 86_400;
  const json = stageJson({ stageId: BigInt(1), root: vector.root, total: BigInt(3_500_007), program, window });
  assert.deepEqual(json, {
    stage_id: 1,
    root: vector.root,
    total: "3500007",
    denom: "erc20:0xa5b3c3Fb92E2E89555F9909b9004C65F3542eE23",
    pool_id: 6,
    start: epochEnd,
    end: epochEnd + 30 * 86_400,
    label: "QWAKK/QOR LP rewards, epoch 1 (2026-11-27 to 2026-12-04)",
  });
  assert.deepEqual(claimWindow({ claimDays: 2 }, window), { startMs: window.endMs, endMs: window.endMs + 2 * 86_400_000 });
  assert.ok(json.label.length <= 128);
});

test("the stage label is cut to the contract's 128 UTF-8 bytes without splitting a character", () => {
  const base = JSON.parse(PROGRAM_JSON)[0];
  const program = loadRewardsConfig({ QWAKK_REWARDS_PROGRAMS: JSON.stringify([{ ...base, label: "ü".repeat(80) }]) }).config.programs[0] as RewardProgram;
  const label = stageJson({ stageId: BigInt(1), root: vector.root, total: BigInt(1), program, window: epochWindow(program, 1) }).label;
  assert.ok(Buffer.byteLength(label, "utf8") <= 128);
  assert.equal(label, "ü".repeat(64));
  assert.equal(truncateUtf8("aü", 2), "a");
  assert.equal(truncateUtf8("🦆🦆", 7), "🦆");
});
