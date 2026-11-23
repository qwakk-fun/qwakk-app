import assert from "node:assert/strict";
import test from "node:test";

import { parseLiquidityEvent, parseSwapEvent, senderTransfers, transactionSender, transfersOf, eventValues } from "../indexer/amm-events";
import { splitPrunedHeights } from "../indexer/block-sync";
import { describePointsConfig, loadPointsConfig, type PointsEnv } from "../indexer/points-config";
import { bandedBps, formatPoints, madeWithoutAnyTransfer, minimumInterfaceFee, paidInterfaceFee, scoreSeason, type ScoringInput, type ScoringLiquidityEvent, type ScoringLpSnapshot, type ScoringSwap } from "../indexer/points-scoring";

const addr = (name: string) => `qor1${name.padEnd(38, "q")}`;
const ALICE = addr("alice"); // steady trader
const BOB = addr("bob"); // wash trader
const CAROL = addr("carol"); // pool creator and LP
const DAVE = addr("dave"); // volume whale
const ERIN = addr("erin"); // dust only
const FRANK = addr("frank");
const GRACE = addr("grace");
const HANK = addr("hank"); // snapshot sniper
const IVY = addr("ivy"); // short then long LP holder
const JACK = addr("jack"); // LP whale
const OWNER = addr("owner"); // excluded

const T0 = Date.parse("2026-10-01T00:00:00Z");
/** ISO time `hours` (and minutes) after T0. */
const at = (hours: number, minutes = 0) => new Date(T0 + (hours * 60 + minutes) * 60_000).toISOString();
/** Five second blocks from height 1000 at T0. */
const heightOf = (iso: string) => 1000 + Math.floor((Date.parse(iso) - T0) / 5000);
const qor = (value: number) => String(Math.round(value * 1_000_000));

let txCounter = 0;
function swap(sender: string, poolId: string, time: string, side: "buy" | "sell", qorAmount: number, other = qorAmount * 2): ScoringSwap {
  txCounter += 1;
  const base = { poolId, height: heightOf(time), executedAt: time, txHash: `SWAP${txCounter}`, eventIndex: 0, sender };
  return side === "buy"
    ? { ...base, denomIn: "uqor", amountIn: qor(qorAmount), denomOut: "utest", amountOut: qor(other) }
    : { ...base, denomIn: "utest", amountIn: qor(other), denomOut: "uqor", amountOut: qor(qorAmount) };
}

function liquidity(eventType: ScoringLiquidityEvent["eventType"], sender: string, poolId: string, time: string, lpAmount: string | null, qorAmount: number | null = null): ScoringLiquidityEvent {
  txCounter += 1;
  return { poolId, height: heightOf(time), executedAt: time, txHash: `LIQ${txCounter}`, eventIndex: 1, eventType, sender, qorAmount: qorAmount === null ? null : qor(qorAmount), lpAmount };
}

const P1 = { lpSupply: "1000000", reserveA: qor(1000), reserveB: qor(2000) };
function snapshots(address: string, poolId: string, fromHour: number, toHour: number, balance: string | ((hour: number) => string), pool: { lpSupply: string; reserveA: string; reserveB: string } = P1): ScoringLpSnapshot[] {
  const list: ScoringLpSnapshot[] = [];
  for (let hour = fromHour; hour <= toHour; hour += 1) {
    const time = at(hour);
    list.push({ poolId, address, snapshotHour: time, height: heightOf(time) + 2, lpBalance: typeof balance === "string" ? balance : balance(hour), ...pool });
  }
  return list;
}

function fixtureSeason(): ScoringInput {
  const day2 = 24;
  const swaps: ScoringSwap[] = [
    // Day 1
    swap(ALICE, "1", at(1), "buy", 100),
    swap(BOB, "1", at(2), "buy", 1000),
    swap(BOB, "1", at(2, 5), "sell", 990), // reverses 990 of the 1000 within the window
    swap(DAVE, "1", at(3), "buy", 5000),
    swap(DAVE, "1", at(3, 10), "buy", 5000),
    swap(DAVE, "1", at(3, 20), "buy", 5000),
    swap(DAVE, "1", at(3, 30), "buy", 5000),
    swap(FRANK, "1", at(4), "buy", 10),
    swap(OWNER, "1", at(4, 30), "buy", 50), // excluded: no points, not a trader for the unlock
    swap(ERIN, "1", at(5), "buy", 0.5), // below the minimum size
    swap(CAROL, "1", at(5, 30), "buy", 20), // the creator trading her own pool
    swap(GRACE, "1", at(6), "buy", 5), // fifth distinct trader: unlocks pool 1
    // A swap in a pool without a uqor side.
    { ...swap(FRANK, "3", at(6, 30), "buy", 1), denomIn: "ufoo", amountIn: "5000000", denomOut: "utest", amountOut: "9000000" },
    // Day 2
    swap(ALICE, "1", at(day2 + 1), "buy", 500),
    swap(BOB, "1", at(day2 + 1), "buy", 100),
    swap(BOB, "1", at(day2 + 3), "sell", 100), // two hours later: not a round trip
    swap(ERIN, "2", at(day2 + 2), "buy", 0.5),
    swap(CAROL, "2", at(day2 + 2), "buy", 5),
    // After throughHeight: ignored until ingestion catches up.
    swap(ALICE, "1", at(49), "buy", 1000),
  ];
  const liquidityEvents: ScoringLiquidityEvent[] = [
    liquidity("pool_created", CAROL, "1", at(0), "500000", 1000),
    liquidity("pool_created", CAROL, "2", at(0, 10), "1000", 1),
    liquidity("pool_created", FRANK, "3", at(0, 20), "1000", null),
    liquidity("pool_created", JACK, "4", at(0, 30), "400000", 50000),
  ];
  // Hank: adds before every snapshot and removes right after it, from 11:59 to 18:01.
  for (let hour = 12; hour <= 18; hour += 1) {
    liquidityEvents.push(liquidity("liquidity_added", HANK, "1", at(hour - 1, 59), "100000", 50));
    liquidityEvents.push(liquidity("liquidity_removed", HANK, "1", at(hour, 1), "100000"));
  }
  // Ivy: 4 hours (too short), out, then 7 hours with a partial removal.
  liquidityEvents.push(liquidity("liquidity_added", IVY, "1", at(day2, 30), "200000", 100));
  liquidityEvents.push(liquidity("liquidity_removed", IVY, "1", at(day2 + 5, 30), "200000"));
  liquidityEvents.push(liquidity("liquidity_added", IVY, "1", at(day2 + 7, 30), "200000", 100));
  liquidityEvents.push(liquidity("liquidity_removed", IVY, "1", at(day2 + 12, 30), "50000"));
  liquidityEvents.push(liquidity("liquidity_added", OWNER, "1", at(0, 40), "100000", 100));

  const lpSnapshots: ScoringLpSnapshot[] = [
    // Carol holds 500k of 1M LP for 10 hours. A reserve spike at hour 3 must not raise her value.
    ...snapshots(CAROL, "1", 0, 10, "500000").map((snapshot) => (snapshot.snapshotHour === at(3) ? { ...snapshot, reserveA: qor(1500) } : snapshot)),
    // Hank's balance looks constant at every snapshot, but every interval contains a full removal.
    ...snapshots(HANK, "1", 12, 18, "100000"),
    ...snapshots(HANK, "1", 19, 19, "0"),
    ...snapshots(IVY, "1", day2 + 1, day2 + 5, "200000"),
    ...snapshots(IVY, "1", day2 + 6, day2 + 6, "0"),
    ...snapshots(IVY, "1", day2 + 8, day2 + 15, (hour) => (hour >= day2 + 13 ? "150000" : "200000")),
    // Jack holds 40% of a 100k QOR pool: 80k QOR per hour, far above the full rate band.
    ...snapshots(JACK, "4", 1, 7, "400000", { lpSupply: "1000000", reserveA: qor(100000), reserveB: qor(1) }),
    ...snapshots(OWNER, "1", 1, 12, "100000"),
  ];

  return {
    throughHeight: heightOf(at(48)),
    pools: [
      { id: "1", tokenA: "uqor", tokenB: "utest", creator: CAROL, createdHeight: heightOf(at(0)) },
      { id: "2", tokenA: "uqor", tokenB: "uzzz", creator: CAROL, createdHeight: heightOf(at(0, 10)) },
      { id: "3", tokenA: "ufoo", tokenB: "utest", creator: FRANK, createdHeight: heightOf(at(0, 20)) },
      { id: "4", tokenA: "uqor", tokenB: "ubig", creator: JACK, createdHeight: heightOf(at(0, 30)) },
    ],
    swaps,
    liquidityEvents,
    lpSnapshots,
  };
}

// The fixture was written for a 10,000 QOR daily ceiling; the default is now 2,000 (tested below).
// No treasury is set, so the interface fee rule is off for the fixture.
const testEnv: PointsEnv = { QWAKK_POINTS_EXCLUDED_ADDRESSES: OWNER, QWAKK_POINTS_SWAP_DAILY_MAX_QOR: "10000" };
const config = (env: PointsEnv = {}) => loadPointsConfig({ ...testEnv, ...env }).config;
const byAddress = (result: ReturnType<typeof scoreSeason>) => new Map(result.addresses.map((entry) => [entry.address, entry]));
const points = (micro: bigint | undefined) => (micro === undefined ? undefined : formatPoints(micro));

test("scores the fixture season with the default rules", () => {
  const result = scoreSeason(fixtureSeason(), config());
  const scores = byAddress(result);

  assert.deepEqual(
    result.addresses.map((entry) => [entry.rank, entry.address, formatPoints(entry.totalMicro)]),
    [
      [1, DAVE, "2850"],
      [2, JACK, "890"],
      [3, CAROL, "725"],
      [4, ALICE, "700"],
      [5, BOB, "508"],
      [6, IVY, "75"],
      [7, FRANK, "60"],
      [8, GRACE, "55"],
      [9, HANK, "50"],
    ],
  );
  const alice = scores.get(ALICE);
  assert.equal(points(alice?.swapMicro), "600");
  assert.equal(points(alice?.activityMicro), "100");
  assert.equal(alice?.activeDays, 2);
  // The swap after throughHeight is not counted.
  assert.equal(alice?.swapVolumeUqor, BigInt(qor(600)));
});

test("down-weights round trips on both legs and only inside the window", () => {
  const bob = byAddress(scoreSeason(fixtureSeason(), config())).get(BOB);
  // Day 1: 10 QOR unmatched + 990 QOR matched on each leg at 10%: 10 + 99 + 99 = 208.
  // Day 2: the reversal came two hours later, so both 100 QOR legs count in full.
  assert.equal(points(bob?.swapMicro), "408");
  assert.equal(bob?.roundTripVolumeUqor, BigInt(qor(1980)));
  assert.equal(bob?.swapVolumeUqor, BigInt(qor(2190)));

  // The same raw data rescored with round trips at full weight shows what the rule removes.
  const lenient = byAddress(scoreSeason(fixtureSeason(), config({ QWAKK_POINTS_ROUND_TRIP_FACTOR_BPS: "10000" }))).get(BOB);
  // Day 1: 1,990 QOR banded to 1,000 + 990 x 20% = 1,198. Day 2: 200.
  assert.equal(points(lenient?.swapMicro), "1398");
});

test("applies the daily swap band and ignores dust, excluded and non-QOR swaps", () => {
  const result = scoreSeason(fixtureSeason(), config());
  const scores = byAddress(result);
  // 20,000 QOR in one day: 1,000 at full rate, 9,000 at 20%, the last 10,000 not at all.
  assert.equal(points(scores.get(DAVE)?.swapMicro), "2800");
  assert.equal(scores.has(ERIN), false);
  assert.equal(scores.has(OWNER), false);
  // Frank's non-QOR swap adds nothing; his 10 QOR swap and one active day remain.
  assert.equal(points(scores.get(FRANK)?.swapMicro), "10");
  assert.equal(scores.get(FRANK)?.activeDays, 1);
});

test("unlocks the pool bonus only after enough other traders, and caps it per creator", () => {
  const result = scoreSeason(fixtureSeason(), config());
  const pools = new Map(result.pools.map((pool) => [pool.poolId, pool]));
  // The owner and the creator do not count, dust does not count: Grace is the fifth trader.
  assert.equal(pools.get("1")?.status, "unlocked");
  assert.equal(pools.get("1")?.distinctTraders, 5);
  assert.equal(pools.get("1")?.unlockedHeight, heightOf(at(6)));
  assert.equal(pools.get("2")?.status, "locked");
  assert.equal(pools.get("2")?.distinctTraders, 0);
  assert.equal(pools.get("3")?.status, "not_scored");
  assert.equal(pools.get("4")?.status, "locked");
  const carol = byAddress(result).get(CAROL);
  assert.equal(points(carol?.poolMicro), "500");
  assert.equal(carol?.poolsCreated, 2);
  assert.equal(carol?.poolsUnlocked, 1);

  // With a one trader threshold and a one pool cap, Carol's second pool is over the limit.
  const capped = scoreSeason(fixtureSeason(), config({ QWAKK_POINTS_POOL_BONUS_MIN_TRADERS: "1", QWAKK_POINTS_POOL_BONUS_MAX_PER_ADDRESS: "1", QWAKK_POINTS_MIN_SWAP_QOR: "0.5" }));
  const cappedPools = new Map(capped.pools.map((pool) => [pool.poolId, pool]));
  assert.equal(cappedPools.get("1")?.status, "unlocked");
  assert.equal(cappedPools.get("2")?.status, "over_limit");
  assert.equal(points(cappedPools.get("2")?.pointsMicro), "0");
  assert.equal(points(byAddress(capped).get(CAROL)?.poolMicro), "500");
});

test("credits liquidity held through each hour, after the minimum hold", () => {
  const scores = byAddress(scoreSeason(fixtureSeason(), config()));
  // Carol: 1,000 QOR of position for 10 hours at 0.01 per QOR-hour. The hour 3 spike is ignored.
  assert.equal(points(scores.get(CAROL)?.liquidityMicro), "100");
  assert.equal(scores.get(CAROL)?.liquidityUqorHours, BigInt(qor(10000)));
  // Hank re-adds before every snapshot: nothing was held through any hour.
  assert.equal(points(scores.get(HANK)?.liquidityMicro), "0");
  assert.equal(points(scores.get(HANK)?.activityMicro), "50");
  // Ivy: the first 4 hour streak is under the 6 hour minimum. The second streak is
  // 4 hours at 400 QOR and 3 hours at 300 QOR after a partial removal: 2,500 QOR-hours.
  assert.equal(points(scores.get(IVY)?.liquidityMicro), "25");
  // Jack: 80,000 QOR per hour is banded to 5,000 + 45,000 x 20% = 14,000 for 6 hours.
  assert.equal(points(scores.get(JACK)?.liquidityMicro), "840");
});

test("rescoring is deterministic and independent of row order", () => {
  const input = fixtureSeason();
  const reversed: ScoringInput = {
    ...input,
    pools: [...input.pools].reverse(),
    swaps: [...input.swaps].reverse(),
    liquidityEvents: [...input.liquidityEvents].reverse(),
    lpSnapshots: [...input.lpSnapshots].reverse(),
  };
  assert.deepEqual(scoreSeason(reversed, config()), scoreSeason(input, config()));
  const daily = scoreSeason(input, config()).daily.filter((row) => row.address === ALICE);
  assert.deepEqual(daily.map((row) => [row.day, formatPoints(row.swapMicro), row.active]), [["2026-10-01", "100", true], ["2026-10-02", "500", true]]);
});

test("respects the season window", () => {
  const input = fixtureSeason();
  const dayTwoOnly = byAddress(scoreSeason(input, config({ QWAKK_POINTS_SEASON_START_HEIGHT: String(heightOf(at(24))) })));
  assert.equal(points(dayTwoOnly.get(ALICE)?.swapMicro), "500");
  assert.equal(dayTwoOnly.has(DAVE), false);
  // Pools created before the season have no bonus.
  assert.equal(points(dayTwoOnly.get(CAROL)?.poolMicro), "0");
  assert.equal(dayTwoOnly.get(CAROL)?.poolsCreated, 0);
});

test("reads the config from the environment and falls back on invalid values", () => {
  const { config: defaults, warnings: none } = loadPointsConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.season, "testnet-1");
  assert.equal(defaults.minSwapUqor, BigInt(1_000_000));
  assert.equal(defaults.swapDailyFullUqor, BigInt(1_000_000_000));
  assert.equal(defaults.swapDailyMaxUqor, BigInt(2_000_000_000));
  assert.equal(defaults.lpPointsPerQorHourPpm, BigInt(10_000));
  assert.deepEqual(none, []);

  const { config: custom, warnings } = loadPointsConfig({
    QWAKK_POINTS_ENABLED: "enabled",
    QWAKK_POINTS_MIN_SWAP_QOR: "abc",
    QWAKK_POINTS_ROUND_TRIP_FACTOR_BPS: "20000",
    QWAKK_POINTS_EXCLUDED_ADDRESSES: `${OWNER.toUpperCase()}, not-an-address`,
    QWAKK_TREASURY_ADDRESS: ALICE,
  });
  assert.equal(custom.enabled, true);
  assert.equal(custom.minSwapUqor, BigInt(1_000_000));
  assert.equal(custom.roundTripFactorBps, BigInt(1000));
  assert.deepEqual(custom.excludedAddresses, [ALICE, OWNER].sort());
  assert.equal(warnings.length, 2);
});

test("bands values exactly in integers", () => {
  assert.equal(bandedBps(BigInt(500), BigInt(1000), BigInt(10000), BigInt(2000)), BigInt(5_000_000));
  assert.equal(bandedBps(BigInt(20000), BigInt(1000), BigInt(10000), BigInt(2000)), BigInt(1000 * 10000 + 9000 * 2000));
  assert.equal(formatPoints(BigInt(1_500_001)), "1.500001");
  assert.equal(formatPoints(BigInt(0)), "0");
});

/** Event shape as CometBFT 0.38 block_results returns it. */
const chainEvent = (type: string, attributes: Record<string, string>) => ({ type, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value, index: true })) });

test("parses liquidity events defensively", () => {
  const added = parseLiquidityEvent("amm_liquidity_added", eventValues(chainEvent("amm_liquidity_added", { pool_id: "7", sender: CAROL, tokens_in: "1000000uqor,2000000utest", lp_minted: "1414213" })));
  assert.deepEqual(added, { eventType: "liquidity_added", poolId: "7", sender: CAROL, coins: "1000000uqor,2000000utest", qorAmount: "1000000", lpAmount: "1414213" });

  const created = parseLiquidityEvent("amm_pool_created", eventValues(chainEvent("amm_pool_created", { pool_id: "8", pool_type: "constant_product", token_a: "uqor", token_b: "utest", amount_a: "5000000", lp_minted: "2000" })), FRANK);
  assert.equal(created?.sender, FRANK);
  assert.equal(created?.qorAmount, "5000000");

  const removed = parseLiquidityEvent("amm_liquidity_removed", eventValues(chainEvent("amm_liquidity_removed", { pool_id: "7", sender: CAROL, tokens_out: "400000uqor,800000utest" })));
  assert.equal(removed?.lpAmount, null);
  assert.equal(removed?.qorAmount, "400000");

  const bare = parseLiquidityEvent("amm_liquidity_added", {});
  assert.deepEqual(bare, { eventType: "liquidity_added", poolId: null, sender: null, coins: null, qorAmount: null, lpAmount: null });
  assert.equal(parseLiquidityEvent("amm_swap", {}), null);
});

test("finds the signer from standard transaction events and parses coin form swaps", () => {
  const events = [chainEvent("tx", { acc_seq: `${DAVE}/4` }), chainEvent("message", { action: "/qorechain.amm.v1.MsgSwapExactIn", sender: ALICE, module: "amm" })];
  assert.equal(transactionSender(events), ALICE);
  assert.equal(transactionSender([events[0]]), DAVE);
  assert.equal(transactionSender([]), null);

  const parsed = parseSwapEvent(eventValues(chainEvent("amm_swap", { pool_id: "1", tokens_in: "1000000uqor", tokens_out: "1990000utest" })), BOB);
  assert.deepEqual(parsed, { poolId: "1", sender: BOB, denomIn: "uqor", amountIn: "1000000", denomOut: "utest", amountOut: "1990000" });
});

// Anti-bot rules.

const TREASURY = addr("treasury");
const KIM = addr("kim");
const LEO = addr("leo");
const MIA = addr("mia");
const NED = addr("ned");
const OLA = addr("ola");
const PIA = addr("pia");
/** Fee rule on, as on the testnet indexer. */
const feeEnv: PointsEnv = { QWAKK_TREASURY_ADDRESS: TREASURY };
const NEW_TREASURY = addr("newtreasury");
const atSec = (hours: number, seconds: number) => new Date(T0 + hours * 3_600_000 + seconds * 1000).toISOString();

/** A swap as the Qwakk app sends it: the fee transfer (`feeBps` of the total, 10 by default) to the treasury in the same transaction. */
function uiSwap(sender: string, poolId: string, time: string, side: "buy" | "sell", qorAmount: number, treasury = TREASURY, feeBps = 10): ScoringSwap {
  const base = swap(sender, poolId, time, side, qorAmount);
  const amountIn = BigInt(base.amountIn);
  const total = (amountIn * BigInt(10000)) / BigInt(10000 - feeBps);
  const fee = String((total * BigInt(feeBps)) / BigInt(10000));
  return { ...base, feeCheck: "checked", senderTransfers: { [treasury]: { [base.denomIn]: fee } } };
}
/** A swap sent to x/amm directly: checked, the sender sent nothing else. */
function directSwap(sender: string, poolId: string, time: string, side: "buy" | "sell", qorAmount: number): ScoringSwap {
  return { ...swap(sender, poolId, time, side, qorAmount), feeCheck: "checked", senderTransfers: {} };
}

function season(swaps: ScoringSwap[], extra: Partial<ScoringInput> = {}): ScoringInput {
  return {
    throughHeight: heightOf(at(72)),
    pools: [{ id: "1", tokenA: "uqor", tokenB: "utest", creator: CAROL, createdHeight: heightOf(at(0)) }],
    swaps,
    liquidityEvents: [liquidity("pool_created", CAROL, "1", at(0), "500000", 1000)],
    lpSnapshots: [],
    ...extra,
  };
}

test("reads the anti-bot settings from the environment", () => {
  const { config: defaults, warnings } = loadPointsConfig(feeEnv);
  assert.deepEqual(warnings, []);
  assert.equal(defaults.requireInterfaceFee, true);
  assert.deepEqual(defaults.feeRecipients, [TREASURY]);
  assert.equal(defaults.minInterfaceFeeBps, 10);
  assert.equal(defaults.oneSwapPerTx, true);
  assert.equal(defaults.minSwapGapSeconds, 60);
  assert.equal(defaults.botBatchMinSwaps, 2);
  assert.equal(defaults.botBurstMinSwaps, 10);
  assert.equal(defaults.botBurstMedianGapSeconds, 30);
  assert.equal(defaults.botDirectMinSwaps, 5);
  assert.deepEqual(defaults.botAddresses, []);
  assert.ok(defaults.excludedAddresses.includes(TREASURY));

  // Without a treasury the app charges no fee, so there is nothing to check: off, and silent unless asked for.
  assert.equal(loadPointsConfig({}).config.requireInterfaceFee, false);
  const asked = loadPointsConfig({ QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "enabled" });
  assert.equal(asked.config.requireInterfaceFee, false);
  assert.equal(asked.warnings.length, 1);
  // The app's own fee setting is not read: a fee switched off or out of range in the app changes nothing here.
  assert.deepEqual(loadPointsConfig({ ...feeEnv, QWAKK_SWAP_FEE_BPS: "50" }), loadPointsConfig(feeEnv));
  // Past treasuries are accepted fee recipients and kept off the leaderboard.
  const rotated = loadPointsConfig({ QWAKK_TREASURY_ADDRESS: NEW_TREASURY, QWAKK_POINTS_PAST_TREASURY_ADDRESSES: TREASURY.toUpperCase() }).config;
  assert.deepEqual(rotated.feeRecipients, [NEW_TREASURY, TREASURY].sort());
  assert.ok(rotated.excludedAddresses.includes(TREASURY));
  assert.equal(loadPointsConfig({ ...feeEnv, QWAKK_POINTS_MIN_INTERFACE_FEE_BPS: "5" }).config.minInterfaceFeeBps, 5);

  const { config: custom, warnings: customWarnings } = loadPointsConfig({
    ...feeEnv,
    QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "disabled",
    QWAKK_POINTS_MIN_SWAP_GAP_SECONDS: "120",
    QWAKK_POINTS_BOT_BATCH_MIN_SWAPS: "0",
    QWAKK_POINTS_BOT_BURST_MIN_SWAPS: "20",
    QWAKK_POINTS_BOT_BURST_MEDIAN_GAP_SECONDS: "15",
    QWAKK_POINTS_BOT_DIRECT_MIN_SWAPS: "3",
    QWAKK_POINTS_BOT_ADDRESSES: `${KIM.toUpperCase()}, nope`,
    QWAKK_POINTS_BOT_ALLOWLIST: LEO,
  });
  assert.deepEqual(customWarnings, []);
  assert.equal(custom.requireInterfaceFee, false);
  assert.equal(custom.minSwapGapSeconds, 120);
  assert.equal(custom.botBatchMinSwaps, 0);
  assert.equal(custom.botBurstMinSwaps, 20);
  assert.equal(custom.botBurstMedianGapSeconds, 15);
  assert.equal(custom.botDirectMinSwaps, 3);
  assert.deepEqual(custom.botAddresses, [KIM]);
  assert.deepEqual(custom.botAllowlist, [LEO]);

  const bad = loadPointsConfig({ ...feeEnv, QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "maybe", QWAKK_POINTS_MIN_SWAP_GAP_SECONDS: "-1", QWAKK_POINTS_MIN_INTERFACE_FEE_BPS: "31" });
  assert.equal(bad.config.requireInterfaceFee, true);
  assert.equal(bad.config.minSwapGapSeconds, 60);
  assert.equal(bad.config.minInterfaceFeeBps, 10);
  assert.equal(bad.warnings.length, 3);
});

test("the default daily ceiling is 2,000 QOR", () => {
  const dave = byAddress(scoreSeason(fixtureSeason(), loadPointsConfig({ QWAKK_POINTS_EXCLUDED_ADDRESSES: OWNER }).config)).get(DAVE);
  // 20,000 QOR in one day: 1,000 at full rate, 1,000 at 20%, the rest not at all.
  assert.equal(points(dave?.swapMicro), "1200");
});

test("the rules version changes with the anti-bot settings", () => {
  const describe = (env: PointsEnv) => JSON.stringify(describePointsConfig(loadPointsConfig(env).config));
  assert.notEqual(describe(feeEnv), describe({ ...feeEnv, QWAKK_POINTS_MIN_SWAP_GAP_SECONDS: "30" }));
  assert.notEqual(describe(feeEnv), describe({ ...feeEnv, QWAKK_POINTS_BOT_BURST_MIN_SWAPS: "11" }));
  assert.notEqual(describe(feeEnv), describe({ ...feeEnv, QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "disabled" }));
  assert.notEqual(describe(feeEnv), describe({ ...feeEnv, QWAKK_POINTS_PAST_TREASURY_ADDRESSES: NEW_TREASURY }));
  assert.notEqual(describe(feeEnv), describe({ ...feeEnv, QWAKK_POINTS_MIN_INTERFACE_FEE_BPS: "5" }));
});

test("checks the interface fee with room for rounding and exact-out swaps", () => {
  const cfg = config(feeEnv);
  // 1,000 QOR swap leg: floor(1e9 * 10 / 10500) = 952,380 uqor at least.
  assert.equal(minimumInterfaceFee(BigInt(1_000_000_000), 10, 500), BigInt(952_380));
  // A fee that rounds to 0 still needs a transfer.
  assert.equal(minimumInterfaceFee(BigInt(50), 10, 500), BigInt(1));
  const paid = (amount: string, recipient = TREASURY, denom = "uqor") => ({ denomIn: "uqor", amountIn: "1000000000", feeCheck: "checked" as const, senderTransfers: { [recipient]: { [denom]: amount } } });
  assert.equal(paidInterfaceFee(paid("1001001"), cfg), true);
  assert.equal(paidInterfaceFee(paid("952380"), cfg), true);
  assert.equal(paidInterfaceFee(paid("952379"), cfg), false);
  assert.equal(paidInterfaceFee(paid("0"), cfg), false);
  assert.equal(paidInterfaceFee(paid("1001001", ALICE), cfg), false);
  assert.equal(paidInterfaceFee(paid("1001001", TREASURY, "utest"), cfg), false);
  assert.equal(paidInterfaceFee({ ...paid("1001001"), feeCheck: null }, cfg), false);
  assert.equal(paidInterfaceFee({ ...paid("1001001"), feeCheck: "unavailable" }, cfg), false);
  // Only an empty transfer list is plain x/amm use; a fee sent anywhere is not.
  assert.equal(madeWithoutAnyTransfer({ ...paid("1"), senderTransfers: {} }), true);
  assert.equal(madeWithoutAnyTransfer(paid("1", ALICE)), false);
  assert.equal(madeWithoutAnyTransfer({ ...paid("1"), feeCheck: "unavailable", senderTransfers: null }), false);
});

test("keeps the transfers a sender made outside AMM messages", () => {
  // Shape of a Qwakk swap on QoreChain Diana (RPC block_results, height 10508374): network fee, fee transfer, then the swap.
  const events = [
    chainEvent("transfer", { recipient: addr("feecollector"), sender: KIM, amount: "56835uqor" }),
    chainEvent("transfer", { recipient: TREASURY, sender: KIM, amount: "2500000uqor", msg_index: "0" }),
    chainEvent("transfer", { recipient: addr("pool"), sender: KIM, amount: "2497500000uqor", msg_index: "1" }),
    chainEvent("transfer", { recipient: KIM, sender: addr("pool"), amount: "5utest", msg_index: "1" }),
    chainEvent("amm_swap", { pool_id: "6", sender: KIM, denom_in: "uqor", amount_in: "2497500000", denom_out: "utest", amount_out: "5", msg_index: "1" }),
    chainEvent("transfer", { recipient: TREASURY, sender: LEO, amount: "7utest,3uqor", msg_index: "2" }),
    chainEvent("transfer", { recipient: TREASURY, sender: LEO.toUpperCase(), amount: "1utest", msg_index: "3" }),
  ];
  const bySender = senderTransfers(events);
  assert.deepEqual(transfersOf(bySender, KIM), { [TREASURY]: { uqor: "2500000" } });
  assert.deepEqual(transfersOf(bySender, LEO), { [TREASURY]: { utest: "8", uqor: "3" } });
  assert.deepEqual(transfersOf(bySender, MIA), {});
  assert.deepEqual(transfersOf(bySender, null), {});
  // A batch of swaps with no other message: nothing remains.
  assert.deepEqual(transfersOf(senderTransfers(events.slice(2, 5)), KIM), {});
});

test("a treasury rotation keeps past swaps counted when the old address is listed", () => {
  const input = season([
    uiSwap(KIM, "1", at(1), "buy", 100, TREASURY),
    uiSwap(KIM, "1", at(25), "buy", 100, NEW_TREASURY),
    ...Array.from({ length: 6 }, (_, index) => uiSwap(LEO, "1", at(2 + index), "buy", 10, TREASURY)),
  ]);
  const before = scoreSeason({ ...input, swaps: input.swaps.filter((entry) => entry.height < heightOf(at(24))) }, config(feeEnv));
  const rotated = config({ QWAKK_TREASURY_ADDRESS: NEW_TREASURY, QWAKK_POINTS_PAST_TREASURY_ADDRESSES: TREASURY });
  const after = byAddress(scoreSeason(input, rotated));
  assert.equal(points(after.get(KIM)?.swapMicro), "200");
  assert.equal(points(after.get(LEO)?.swapMicro), points(byAddress(before).get(LEO)?.swapMicro));
  // Rotated without listing the old address: those swaps stop counting, but nobody is flagged as direct.
  const unlisted = scoreSeason(input, config({ QWAKK_TREASURY_ADDRESS: NEW_TREASURY }));
  assert.deepEqual(unlisted.flagged, []);
  assert.equal(points(byAddress(unlisted).get(KIM)?.swapMicro), "100");
});

test("raising the app fee changes no past result", () => {
  const input = season([
    uiSwap(KIM, "1", at(1), "buy", 100, TREASURY, 10),
    uiSwap(KIM, "1", at(25), "buy", 100, TREASURY, 30), // after the app fee went up to 30 bps
  ]);
  const before = scoreSeason(input, config(feeEnv));
  assert.deepEqual(scoreSeason(input, config({ ...feeEnv, QWAKK_SWAP_FEE_BPS: "30" })), before);
  assert.equal(points(byAddress(before).get(KIM)?.swapMicro), "200");
});

test("with the fee rule off, plain x/amm use flags nobody", () => {
  const swaps = Array.from({ length: 6 }, (_, index) => directSwap(KIM, "1", at(1 + index), "buy", 10));
  assert.deepEqual(scoreSeason(season(swaps), config(feeEnv)).flagged, [{ address: KIM, reasons: ["direct_swaps"] }]);
  const off = scoreSeason(season(swaps), config({ ...feeEnv, QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "disabled" }));
  assert.deepEqual(off.flagged, []);
  assert.equal(points(byAddress(off).get(KIM)?.swapMicro), "60");
  // No treasury at all turns the rule, and the signal, off too.
  assert.deepEqual(scoreSeason(season(swaps), config()).flagged, []);
});

test("swaps in blocks the node no longer keeps are given up, not counted and never direct", () => {
  assert.deepEqual(splitPrunedHeights([5, 10, 15], 10), { pruned: [5], readable: [10, 15] });
  assert.deepEqual(splitPrunedHeights([5, 10], 0), { pruned: [], readable: [5, 10] });
  const gone = Array.from({ length: 6 }, (_, index): ScoringSwap => ({ ...swap(KIM, "1", at(1 + index), "buy", 10), feeCheck: "unavailable", senderTransfers: null }));
  const result = scoreSeason(season(gone), config(feeEnv));
  assert.deepEqual(result.flagged, []);
  assert.equal(byAddress(result).has(KIM), false);
});

test("only swaps made through Qwakk count", () => {
  const input = season([
    uiSwap(KIM, "1", at(1), "buy", 100),
    directSwap(LEO, "1", at(1), "buy", 100),
    { ...swap(MIA, "1", at(1), "buy", 100), feeCheck: null, senderTransfers: null }, // not checked yet
    uiSwap(NED, "1", at(1), "buy", 100, ALICE), // paid someone else
  ]);
  const result = scoreSeason(input, config(feeEnv));
  const scores = byAddress(result);
  assert.equal(points(scores.get(KIM)?.swapMicro), "100");
  assert.equal(points(scores.get(KIM)?.activityMicro), "50");
  // Direct and unchecked swaps score nothing and do not make a day active.
  assert.equal(scores.has(LEO), false);
  assert.equal(scores.has(MIA), false);
  assert.equal(scores.has(NED), false);
  assert.deepEqual(result.flagged, []);

  // With the rule off the same data scores all four.
  const off = byAddress(scoreSeason(input, config({ ...feeEnv, QWAKK_POINTS_REQUIRE_INTERFACE_FEE: "disabled" })));
  assert.equal(points(off.get(LEO)?.swapMicro), "100");
  assert.equal(points(off.get(MIA)?.swapMicro), "100");
});

test("reports ignored volume by reason next to counted volume", () => {
  const result = scoreSeason(season([
    uiSwap(KIM, "1", atSec(1, 0), "buy", 100),
    directSwap(KIM, "1", atSec(2, 0), "buy", 40),
    uiSwap(KIM, "1", atSec(3, 0), "buy", 50),
    uiSwap(KIM, "1", atSec(3, 20), "buy", 30),
  ]), config(feeEnv));
  const kim = byAddress(result).get(KIM);
  assert.equal(kim?.swapVolumeUqor, BigInt(qor(150)));
  assert.deepEqual(kim?.ignoredSwapVolumeUqor, { notOnQwakk: BigInt(qor(40)), extraInTx: BigInt(0), tooSoon: BigInt(qor(30)) });
});

test("only the first swap of a transaction counts", () => {
  const first = uiSwap(KIM, "1", at(1), "buy", 100);
  const second = { ...uiSwap(KIM, "1", at(1), "buy", 300), txHash: first.txHash, eventIndex: 9 };
  // The batch signal is off here so the per-swap rule shows on its own.
  const kim = byAddress(scoreSeason(season([second, first]), config({ ...feeEnv, QWAKK_POINTS_BOT_BATCH_MIN_SWAPS: "0" }))).get(KIM);
  assert.equal(points(kim?.swapMicro), "100");
  assert.equal(kim?.ignoredSwapVolumeUqor.extraInTx, BigInt(qor(300)));
});

test("a swap too soon after the previous counted swap scores nothing", () => {
  const kim = byAddress(scoreSeason(season([
    uiSwap(KIM, "1", atSec(1, 0), "buy", 10),
    uiSwap(KIM, "1", atSec(1, 30), "buy", 20), // 30 s after a counted swap
    uiSwap(KIM, "1", atSec(1, 61), "buy", 40), // 61 s after the last counted swap
    uiSwap(KIM, "1", atSec(1, 100), "buy", 80), // 39 s after the last counted swap
  ]), config(feeEnv))).get(KIM);
  assert.equal(points(kim?.swapMicro), "50");
  assert.equal(kim?.ignoredSwapVolumeUqor.tooSoon, BigInt(qor(100)));

  // The gap is measured from the last counted swap in any pool, and 0 turns it off.
  const off = byAddress(scoreSeason(season([uiSwap(KIM, "1", atSec(1, 0), "buy", 10), uiSwap(KIM, "1", atSec(1, 30), "buy", 20)]), config({ ...feeEnv, QWAKK_POINTS_MIN_SWAP_GAP_SECONDS: "0" }))).get(KIM);
  assert.equal(points(off?.swapMicro), "30");
});

test("swaps that do not count still reveal a round trip", () => {
  // A counted buy reversed straight on x/amm two minutes later: the counted leg is still a round trip.
  const kim = byAddress(scoreSeason(season([
    uiSwap(KIM, "1", atSec(1, 0), "buy", 100),
    directSwap(KIM, "1", atSec(1, 120), "sell", 100),
  ]), config(feeEnv))).get(KIM);
  assert.equal(kim?.roundTripVolumeUqor, BigInt(qor(100)));
  assert.equal(points(kim?.swapMicro), "10");
});

test("direct and throttled swaps do not unlock the pool bonus", () => {
  const traders = [KIM, LEO, MIA, NED];
  const base = traders.map((trader, index) => uiSwap(trader, "1", at(1, index), "buy", 5));
  // The fifth trader only swaps directly, or only too soon after a counted swap in another pool.
  const direct = scoreSeason(season([...base, directSwap(OLA, "1", at(2), "buy", 5)]), config(feeEnv));
  assert.equal(direct.pools[0].status, "locked");
  assert.equal(direct.pools[0].distinctTraders, 4);

  const pools = [
    { id: "1", tokenA: "uqor", tokenB: "utest", creator: CAROL, createdHeight: heightOf(at(0)) },
    { id: "2", tokenA: "uqor", tokenB: "uzzz", creator: PIA, createdHeight: heightOf(at(0)) },
  ];
  const throttled = scoreSeason(season([...base, uiSwap(OLA, "2", atSec(2, 0), "buy", 5), uiSwap(OLA, "1", atSec(2, 20), "buy", 5)], { pools }), config(feeEnv));
  assert.equal(throttled.pools.find((pool) => pool.poolId === "1")?.status, "locked");

  const counted = scoreSeason(season([...base, uiSwap(OLA, "1", at(2), "buy", 5)]), config(feeEnv));
  assert.equal(counted.pools[0].status, "unlocked");
});

test("flags batch, burst and direct bots and leaves them off the leaderboard", () => {
  const batch = uiSwap(KIM, "1", at(1), "buy", 100);
  const swaps: ScoringSwap[] = [
    // Kim: one transaction with two swaps.
    batch,
    { ...uiSwap(KIM, "1", at(1), "buy", 100), txHash: batch.txHash, eventIndex: 5 },
    // Leo: 10 swaps 20 s apart on one day, checked but short of the interface fee (a hand made fee transfer).
    ...Array.from({ length: 10 }, (_, index): ScoringSwap => ({ ...swap(LEO, "1", atSec(2, index * 20), "buy", 50), feeCheck: "checked", senderTransfers: { [TREASURY]: { uqor: "1" } } })),
    // Pia: 12 Qwakk swaps 10 s apart on one day, a person clicking fast in the app: not flagged.
    ...Array.from({ length: 12 }, (_, index) => uiSwap(PIA, "1", atSec(7, index * 10), "buy", 50)),
    // Mia: 5 swaps without the interface fee, an hour apart.
    ...Array.from({ length: 5 }, (_, index) => directSwap(MIA, "1", at(3 + index), "buy", 50)),
    // Ned: 10 swaps 40 s apart, 9 swaps 5 s apart the next day, then 4 direct and 3 unchecked swaps an hour apart: not flagged.
    ...Array.from({ length: 10 }, (_, index) => uiSwap(NED, "1", atSec(4, index * 40), "buy", 5)),
    ...Array.from({ length: 9 }, (_, index) => uiSwap(NED, "1", atSec(26, index * 5), "buy", 5)),
    ...Array.from({ length: 4 }, (_, index) => directSwap(NED, "1", at(50 + index), "buy", 5)),
    ...Array.from({ length: 3 }, (_, index): ScoringSwap => ({ ...swap(NED, "1", at(60 + index), "buy", 5), feeCheck: null, senderTransfers: null })),
    // Ola: a normal trader who also helps unlock pool 1.
    uiSwap(OLA, "1", at(5), "buy", 20),
  ];
  // Leo also holds liquidity; a flag removes all of an address's points.
  const lpSnapshots = snapshots(LEO, "1", 0, 10, "500000");
  const result = scoreSeason(season(swaps, { lpSnapshots }), config(feeEnv));
  assert.deepEqual(result.flagged, [
    { address: KIM, reasons: ["batch_swaps"] },
    { address: LEO, reasons: ["burst_trading"] },
    { address: MIA, reasons: ["direct_swaps"] },
  ].sort((a, b) => a.address.localeCompare(b.address)));
  const ranked = result.addresses.map((entry) => entry.address);
  assert.deepEqual(new Set(ranked), new Set([NED, OLA, PIA, CAROL]));
  assert.equal(result.daily.some((row) => [KIM, LEO, MIA].includes(row.address)), false);
  // Flagged traders are not pool traders: only Ned, Ola and Pia count.
  assert.equal(result.pools[0].distinctTraders, 3);
  // Pia's fast clicks are throttled by the swap gap instead: 2 of her 12 swaps count.
  assert.equal(byAddress(result).get(PIA)?.swapVolumeUqor, BigInt(qor(100)));
  // Ranks stay contiguous without the flagged addresses.
  assert.deepEqual(result.addresses.map((entry) => entry.rank), [1, 2, 3, 4]);
});

test("the manual list always flags and the allowlist stops automatic flags", () => {
  const swaps = [
    ...Array.from({ length: 10 }, (_, index) => uiSwap(LEO, "1", atSec(2, index * 20), "buy", 50)),
    uiSwap(KIM, "1", at(1), "buy", 100),
  ];
  // Without the fee rule every fast swap feeds the burst signal, so Leo's burst is real here.
  const result = scoreSeason(season(swaps), config({ QWAKK_POINTS_BOT_ADDRESSES: `${KIM},${MIA}`, QWAKK_POINTS_BOT_ALLOWLIST: `${LEO},${MIA}` }));
  // Kim is listed; Mia is listed and allowlisted (the list wins) without any swap; Leo's burst is allowed.
  assert.deepEqual(result.flagged, [{ address: KIM, reasons: ["manual"] }, { address: MIA, reasons: ["manual"] }].sort((a, b) => a.address.localeCompare(b.address)));
  assert.equal(byAddress(result).has(KIM), false);
  assert.equal(byAddress(result).has(LEO), true);
  // Excluded addresses are never reported as flagged.
  assert.deepEqual(scoreSeason(season(swaps.slice(-1)), config({ ...feeEnv, QWAKK_POINTS_BOT_ADDRESSES: OWNER })).flagged, []);
});
