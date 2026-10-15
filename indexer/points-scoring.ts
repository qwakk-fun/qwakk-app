/**
 * Deterministic scoring for the Qwakk testnet points season.
 *
 * `scoreSeason` is a pure function of the stored raw data (swaps, liquidity
 * events, hourly LP snapshots, pools) and the config. It keeps no state, so
 * the indexer rescores the whole season from scratch on every run and a rule
 * change applies to the full history. All math is integer: amounts in uqor,
 * points in micro points (1 point = 1_000_000), factors in basis points.
 *
 * Categories:
 * - swaps: counted QOR volume per UTC day, round trips down-weighted, then a
 *   full-rate band, a reduced-rate band and a hard daily ceiling.
 * - liquidity: QOR value of the LP position held continuously between two
 *   hourly snapshots, per hour, with the same banding per address and hour.
 *   Holding streaks shorter than the minimum hold score nothing.
 * - pools: a one-time bonus per created pool once enough other addresses
 *   have made counted swaps in it, limited per creator.
 * - activity: a flat amount per distinct UTC day with a qualifying action.
 */

import type { PointsConfig } from "./points-config";

export type ScoringPool = {
  id: string;
  tokenA: string;
  tokenB: string;
  creator: string | null;
  createdHeight: number | null;
};

export type ScoringSwap = {
  poolId: string;
  height: number;
  executedAt: string;
  txHash: string;
  eventIndex: number;
  sender: string | null;
  denomIn: string;
  amountIn: string;
  denomOut: string;
  amountOut: string;
};

export type ScoringLiquidityEvent = {
  poolId: string | null;
  height: number;
  executedAt: string;
  txHash: string;
  eventIndex: number;
  eventType: "pool_created" | "liquidity_added" | "liquidity_removed";
  sender: string | null;
  qorAmount: string | null;
  lpAmount: string | null;
};

export type ScoringLpSnapshot = {
  poolId: string;
  address: string;
  /** Start of the UTC hour the snapshot belongs to (ISO). */
  snapshotHour: string;
  /** Chain height the LP balance was read at. */
  height: number;
  lpBalance: string;
  lpSupply: string;
  reserveA: string;
  reserveB: string;
};

export type ScoringInput = {
  /** Highest block whose events are fully ingested. Later data is ignored until ingestion catches up. */
  throughHeight: number;
  pools: ScoringPool[];
  swaps: ScoringSwap[];
  liquidityEvents: ScoringLiquidityEvent[];
  lpSnapshots: ScoringLpSnapshot[];
};

export type AddressScore = {
  address: string;
  rank: number;
  totalMicro: bigint;
  swapMicro: bigint;
  liquidityMicro: bigint;
  poolMicro: bigint;
  activityMicro: bigint;
  activeDays: number;
  /** QOR volume of swaps at or above the minimum size. */
  swapVolumeUqor: bigint;
  /** Part of that volume matched as a round trip. */
  roundTripVolumeUqor: bigint;
  /** Sum of position value times hours credited, before banding. */
  liquidityUqorHours: bigint;
  poolsCreated: number;
  poolsUnlocked: number;
  firstHeight: number;
  lastHeight: number;
};

export type DailyScore = {
  address: string;
  day: string;
  swapVolumeUqor: bigint;
  roundTripVolumeUqor: bigint;
  swapMicro: bigint;
  liquidityMicro: bigint;
  active: boolean;
};

export type PoolBonusStatus = "locked" | "unlocked" | "over_limit" | "not_scored";

export type PoolBonus = {
  poolId: string;
  creator: string;
  createdHeight: number;
  distinctTraders: number;
  status: PoolBonusStatus;
  unlockedHeight: number | null;
  pointsMicro: bigint;
};

export type SeasonScore = {
  addresses: AddressScore[];
  daily: DailyScore[];
  pools: PoolBonus[];
};

const ZERO = BigInt(0);
const BPS = BigInt(10000);
const MICRO = BigInt(1000000);
const HOUR_MS = 3_600_000;
const ADDRESS_PATTERN = /^qor1[0-9a-z]{20,}$/;

/** Appends to the list stored under `key`, creating it once. Never copies the list. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
const DIGITS = /^\d+$/;

function big(value: string | null | undefined) {
  return DIGITS.test(value ?? "") ? BigInt(value as string) : ZERO;
}

function minBig(a: bigint, b: bigint) {
  return a < b ? a : b;
}

function maxBig(a: bigint, b: bigint) {
  return a > b ? a : b;
}

function utcDay(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Banded value, scaled by 10000: the part up to `full` counts at 1x, the part
 * between `full` and `max` at `factorBps`, anything above `max` not at all.
 */
export function bandedBps(value: bigint, full: bigint, max: bigint, factorBps: bigint) {
  if (value <= ZERO) return ZERO;
  const fullPart = minBig(value, full);
  const reducedPart = maxBig(ZERO, minBig(value, max) - full);
  return fullPart * BPS + reducedPart * factorBps;
}

function poolQorSide(pool: ScoringPool): "a" | "b" | null {
  if (pool.tokenA === "uqor") return "a";
  if (pool.tokenB === "uqor") return "b";
  return null;
}

/** QOR side of a swap in uqor, or null when neither side is uqor. */
export function swapQorAmount(swap: Pick<ScoringSwap, "denomIn" | "amountIn" | "denomOut" | "amountOut">) {
  if (swap.denomIn === "uqor") return big(swap.amountIn);
  if (swap.denomOut === "uqor") return big(swap.amountOut);
  return null;
}

type AddressAccumulator = {
  swapVolumeUqor: bigint;
  roundTripVolumeUqor: bigint;
  liquidityUqorHours: bigint;
  poolsCreated: number;
  poolsUnlocked: number;
  poolMicro: bigint;
  firstHeight: number;
  lastHeight: number;
  days: Map<string, { swapVolumeUqor: bigint; roundTripVolumeUqor: bigint; weightedBps: bigint; liquidityBands: bigint; active: boolean }>;
};

export function scoreSeason(input: ScoringInput, config: PointsConfig): SeasonScore {
  const excluded = new Set(config.excludedAddresses.map((address) => address.toLowerCase()));
  const inSeason = (height: number) =>
    Number.isSafeInteger(height) &&
    height >= config.seasonStartHeight &&
    (config.seasonEndHeight === null || height <= config.seasonEndHeight) &&
    height <= input.throughHeight;
  const eligible = (address: string | null | undefined): address is string =>
    typeof address === "string" && ADDRESS_PATTERN.test(address) && !excluded.has(address);

  const pools = new Map(input.pools.map((pool) => [pool.id, pool]));
  const accounts = new Map<string, AddressAccumulator>();

  function account(address: string, height: number) {
    let entry = accounts.get(address);
    if (!entry) {
      entry = { swapVolumeUqor: ZERO, roundTripVolumeUqor: ZERO, liquidityUqorHours: ZERO, poolsCreated: 0, poolsUnlocked: 0, poolMicro: ZERO, firstHeight: height, lastHeight: height, days: new Map() };
      accounts.set(address, entry);
    }
    entry.firstHeight = Math.min(entry.firstHeight, height);
    entry.lastHeight = Math.max(entry.lastHeight, height);
    return entry;
  }

  function day(entry: AddressAccumulator, key: string) {
    let value = entry.days.get(key);
    if (!value) {
      value = { swapVolumeUqor: ZERO, roundTripVolumeUqor: ZERO, weightedBps: ZERO, liquidityBands: ZERO, active: false };
      entry.days.set(key, value);
    }
    return value;
  }

  // Swaps. Every swap in a scored pool takes part in round trip matching, even
  // below the minimum size, so a large leg cannot be reversed in dust to dodge it.
  const swaps = input.swaps
    .map((swap) => ({ ...swap, sender: swap.sender?.toLowerCase() ?? null, qor: swapQorAmount(swap), time: new Date(swap.executedAt).getTime() }))
    .filter((swap) => inSeason(swap.height) && eligible(swap.sender) && swap.qor !== null && swap.qor > ZERO && pools.has(swap.poolId) && Number.isFinite(swap.time))
    .sort((a, b) => a.height - b.height || a.time - b.time || a.txHash.localeCompare(b.txHash) || a.eventIndex - b.eventIndex);

  type Leg = { denomIn: string; time: number; remaining: bigint; matched: bigint };
  const openLegs = new Map<string, Leg[]>();
  const legs: Leg[] = [];
  const windowMs = config.roundTripWindowSeconds * 1000;
  for (const swap of swaps) {
    const key = `${swap.sender}|${swap.poolId}`;
    const open = (openLegs.get(key) ?? []).filter((leg) => swap.time - leg.time <= windowMs && leg.remaining > ZERO);
    const leg: Leg = { denomIn: swap.denomIn, time: swap.time, remaining: swap.qor as bigint, matched: ZERO };
    for (const earlier of open) {
      if (leg.remaining === ZERO) break;
      if (earlier.denomIn !== swap.denomOut) continue;
      const matched = minBig(earlier.remaining, leg.remaining);
      earlier.remaining -= matched;
      earlier.matched += matched;
      leg.remaining -= matched;
      leg.matched += matched;
    }
    open.push(leg);
    openLegs.set(key, open);
    legs.push(leg);
  }

  swaps.forEach((swap, index) => {
    const qor = swap.qor as bigint;
    if (qor < config.minSwapUqor) return;
    const leg = legs[index];
    const entry = account(swap.sender as string, swap.height);
    const bucket = day(entry, utcDay(swap.executedAt));
    const matched = minBig(leg.matched, qor);
    bucket.swapVolumeUqor += qor;
    bucket.roundTripVolumeUqor += matched;
    bucket.weightedBps += (qor - matched) * BPS + matched * config.roundTripFactorBps;
    bucket.active = true;
    entry.swapVolumeUqor += qor;
    entry.roundTripVolumeUqor += matched;
  });

  // Liquidity adds and pool creations count as activity when their QOR side is known and large enough.
  for (const event of input.liquidityEvents) {
    if (event.eventType === "liquidity_removed" || !inSeason(event.height)) continue;
    const sender = event.sender?.toLowerCase() ?? null;
    if (!eligible(sender) || big(event.qorAmount) < config.minActionUqor || big(event.qorAmount) === ZERO) continue;
    day(account(sender, event.height), utcDay(event.executedAt)).active = true;
  }

  // Pool bonus.
  const creationHeights = new Map<string, number>();
  for (const event of input.liquidityEvents) {
    if (event.eventType === "pool_created" && event.poolId && !creationHeights.has(event.poolId)) creationHeights.set(event.poolId, event.height);
  }
  // Counted swaps grouped by pool once, in the same chronological order as `swaps`.
  const countedSwapsByPool = new Map<string, typeof swaps>();
  for (const swap of swaps) {
    if ((swap.qor as bigint) >= config.minSwapUqor) pushTo(countedSwapsByPool, swap.poolId, swap);
  }
  const bonuses: PoolBonus[] = [];
  for (const pool of [...pools.values()].sort((a, b) => Number(a.id) - Number(b.id))) {
    const createdHeight = pool.createdHeight ?? creationHeights.get(pool.id) ?? null;
    const creator = pool.creator?.toLowerCase() ?? null;
    if (createdHeight === null || !inSeason(createdHeight) || !eligible(creator)) continue;
    const traders = new Set<string>();
    let unlockedHeight: number | null = null;
    if (poolQorSide(pool)) {
      for (const swap of countedSwapsByPool.get(pool.id) ?? []) {
        if (swap.sender === creator) continue;
        traders.add(swap.sender as string);
        if (unlockedHeight === null && traders.size >= config.poolBonusMinTraders) unlockedHeight = swap.height;
      }
    }
    const status: PoolBonusStatus = !poolQorSide(pool) ? "not_scored" : unlockedHeight === null ? "locked" : "unlocked";
    bonuses.push({ poolId: pool.id, creator, createdHeight, distinctTraders: traders.size, status, unlockedHeight, pointsMicro: ZERO });
    account(creator, createdHeight).poolsCreated += 1;
  }
  const unlockedByCreator = new Map<string, PoolBonus[]>();
  for (const bonus of bonuses.filter((entry) => entry.status === "unlocked")) {
    pushTo(unlockedByCreator, bonus.creator, bonus);
  }
  for (const [creator, list] of unlockedByCreator) {
    list.sort((a, b) => (a.unlockedHeight as number) - (b.unlockedHeight as number) || Number(a.poolId) - Number(b.poolId));
    const entry = account(creator, list[0].createdHeight);
    list.forEach((bonus, index) => {
      if (index >= config.poolBonusMaxPerAddress) {
        bonus.status = "over_limit";
        return;
      }
      bonus.pointsMicro = config.poolBonusPointsPpm;
      entry.poolMicro += bonus.pointsMicro;
      entry.poolsUnlocked += 1;
    });
  }

  // Liquidity. For each pair of consecutive snapshots of one position, the
  // amount held through the whole interval is the earlier balance minus
  // everything removed in between (adds in between arrived later, so they do
  // not count), capped by the later balance. A removal without a readable LP
  // amount is treated as a full removal.
  const removals = new Map<string, Array<{ height: number; lp: bigint | null }>>();
  for (const event of input.liquidityEvents) {
    if (event.eventType !== "liquidity_removed" || !event.poolId) continue;
    const sender = event.sender?.toLowerCase();
    if (!sender) continue;
    const key = `${sender}|${event.poolId}`;
    pushTo(removals, key, { height: event.height, lp: DIGITS.test(event.lpAmount ?? "") ? BigInt(event.lpAmount as string) : null });
  }

  const positions = new Map<string, ScoringLpSnapshot[]>();
  for (const snapshot of input.lpSnapshots) {
    const address = snapshot.address.toLowerCase();
    const pool = pools.get(snapshot.poolId);
    if (!pool || !poolQorSide(pool) || !eligible(address) || !inSeason(snapshot.height)) continue;
    const key = `${address}|${snapshot.poolId}`;
    pushTo(positions, key, { ...snapshot, address });
  }

  // Value per address and hour start, summed across pools before banding.
  const hourly = new Map<string, Map<number, bigint>>();
  const unitValue = (snapshot: ScoringLpSnapshot, side: "a" | "b", held: bigint) => {
    const supply = big(snapshot.lpSupply);
    if (supply === ZERO) return ZERO;
    return (held * BigInt(2) * big(side === "a" ? snapshot.reserveA : snapshot.reserveB)) / supply;
  };

  for (const [key, list] of positions) {
    const [address, poolId] = key.split("|");
    const side = poolQorSide(pools.get(poolId) as ScoringPool) as "a" | "b";
    list.sort((a, b) => new Date(a.snapshotHour).getTime() - new Date(b.snapshotHour).getTime() || a.height - b.height);
    const positionRemovals = removals.get(key) ?? [];
    let streak: Array<{ endHour: number; hours: number; value: bigint; height: number }> = [];
    let streakHours = 0;

    const closeStreak = () => {
      if (streakHours >= config.lpMinHoldHours) {
        const entry = account(address, streak[0].height);
        for (const interval of streak) {
          entry.lastHeight = Math.max(entry.lastHeight, interval.height);
          for (let offset = 0; offset < interval.hours; offset += 1) {
            const hourStart = interval.endHour - (offset + 1) * HOUR_MS;
            const byHour = hourly.get(address) ?? new Map<number, bigint>();
            byHour.set(hourStart, (byHour.get(hourStart) ?? ZERO) + interval.value);
            hourly.set(address, byHour);
            entry.liquidityUqorHours += interval.value;
          }
        }
      }
      streak = [];
      streakHours = 0;
    };

    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      const startHour = new Date(previous.snapshotHour).getTime();
      const endHour = new Date(current.snapshotHour).getTime();
      const spanHours = Math.floor((endHour - startHour) / HOUR_MS);
      if (!Number.isFinite(spanHours) || spanHours <= 0) continue;

      let removed = ZERO;
      let fullRemoval = false;
      for (const removal of positionRemovals) {
        if (removal.height <= previous.height || removal.height > current.height) continue;
        if (removal.lp === null) fullRemoval = true;
        else removed += removal.lp;
      }
      const held = fullRemoval ? ZERO : maxBig(ZERO, minBig(big(previous.lpBalance) - removed, big(current.lpBalance)));
      if (held === ZERO) {
        closeStreak();
        continue;
      }
      // Valued at the lower of the two snapshots, so a reserve spike at one snapshot does not inflate it.
      const value = minBig(unitValue(previous, side, held), unitValue(current, side, held));
      const hours = Math.min(spanHours, config.lpMaxIntervalHours);
      streak.push({ endHour, hours, value, height: current.height });
      streakHours += hours;
    }
    closeStreak();
  }

  for (const [address, byHour] of hourly) {
    const entry = accounts.get(address) as AddressAccumulator;
    for (const [hourStart, value] of byHour) {
      const bucket = day(entry, new Date(hourStart).toISOString().slice(0, 10));
      bucket.liquidityBands += bandedBps(value, config.lpHourlyFullUqor, config.lpHourlyMaxUqor, config.lpExcessFactorBps);
    }
  }

  // Totals. Each day is floored to whole micro points once, so totals equal the sum of the daily rows.
  const daily: DailyScore[] = [];
  const addresses: AddressScore[] = [];
  const swapDivisor = MICRO * BPS * BPS;
  const lpDivisor = MICRO * BPS;
  for (const [address, entry] of accounts) {
    let swapMicro = ZERO;
    let liquidityMicro = ZERO;
    let activeDays = 0;
    for (const [dayKey, bucket] of [...entry.days].sort(([a], [b]) => a.localeCompare(b))) {
      const daySwap = (bandedBps(bucket.weightedBps, config.swapDailyFullUqor * BPS, config.swapDailyMaxUqor * BPS, config.swapExcessFactorBps) * config.swapPointsPerQorPpm) / swapDivisor;
      const dayLiquidity = (bucket.liquidityBands * config.lpPointsPerQorHourPpm) / lpDivisor;
      swapMicro += daySwap;
      liquidityMicro += dayLiquidity;
      if (bucket.active) activeDays += 1;
      daily.push({ address, day: dayKey, swapVolumeUqor: bucket.swapVolumeUqor, roundTripVolumeUqor: bucket.roundTripVolumeUqor, swapMicro: daySwap, liquidityMicro: dayLiquidity, active: bucket.active });
    }
    const activityMicro = BigInt(activeDays) * config.activeDayPointsPpm;
    const totalMicro = swapMicro + liquidityMicro + entry.poolMicro + activityMicro;
    addresses.push({
      address,
      rank: 0,
      totalMicro,
      swapMicro,
      liquidityMicro,
      poolMicro: entry.poolMicro,
      activityMicro,
      activeDays,
      swapVolumeUqor: entry.swapVolumeUqor,
      roundTripVolumeUqor: entry.roundTripVolumeUqor,
      liquidityUqorHours: entry.liquidityUqorHours,
      poolsCreated: entry.poolsCreated,
      poolsUnlocked: entry.poolsUnlocked,
      firstHeight: entry.firstHeight,
      lastHeight: entry.lastHeight,
    });
  }

  // Ties go to the address that took part first, then to address order, so ranks never flicker.
  const ranked = addresses
    .filter((entry) => entry.totalMicro > ZERO)
    .sort((a, b) => (a.totalMicro === b.totalMicro ? 0 : a.totalMicro > b.totalMicro ? -1 : 1) || a.firstHeight - b.firstHeight || a.address.localeCompare(b.address));
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  const rankedSet = new Set(ranked.map((entry) => entry.address));
  return {
    addresses: ranked,
    daily: daily.filter((entry) => rankedSet.has(entry.address)).sort((a, b) => a.address.localeCompare(b.address) || a.day.localeCompare(b.day)),
    pools: bonuses,
  };
}

/** Formats micro points as a plain decimal string without trailing zeros. */
export function formatPoints(micro: bigint) {
  const negative = micro < ZERO;
  const digits = (negative ? -micro : micro).toString().padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
