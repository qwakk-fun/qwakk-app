import assert from "node:assert/strict";
import test from "node:test";

import { parseLiquidityEvent, parseSwapEvent, transactionSender, eventValues } from "../indexer/amm-events";
import { loadPointsConfig, type PointsEnv } from "../indexer/points-config";
import { bandedBps, formatPoints, scoreSeason, type ScoringInput, type ScoringLiquidityEvent, type ScoringLpSnapshot, type ScoringSwap } from "../indexer/points-scoring";

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

const testEnv: PointsEnv = { QWAKK_POINTS_EXCLUDED_ADDRESSES: OWNER };
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
