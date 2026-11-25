/**
 * Time-weighted LP share for Qwakk liquidity rewards. Pure and deterministic:
 * the same snapshots, removals and parameters always give the same result.
 *
 * Inputs are the hourly LP balance snapshots of one pool (read from the
 * chain's LP balance query, /qorechain/amm/v1/pools/{id}/lp/{address}) and
 * the pool's liquidity removal events. LP shares cannot be transferred, so an
 * address's balance only changes through its own adds and removals.
 *
 * Holding rule, the same as the points program's liquidity category: between
 * two consecutive snapshots of one position, the amount held through the whole
 * interval is the earlier balance minus everything removed in between, capped
 * by the later balance. Adds in between are not credited until the next
 * interval, and a removal without a readable LP amount counts as a full
 * removal. A gap longer than `maxGapHours` is credited for `maxGapHours` only.
 * Consecutive held intervals form a streak; a streak shorter than
 * `minHoldHours` earns nothing, so add-then-remove gaming earns nothing.
 *
 * Share-seconds = LP units held x seconds of the credited interval inside the
 * epoch window [start, end). All LP units belong to the same pool, so they are
 * compared directly without pricing.
 *
 * Reward = floor(budget x address share-seconds / total eligible
 * share-seconds). The rounding remainder (dust) stays unallocated.
 */

export type RewardSnapshot = {
  address: string;
  /** Start of the UTC hour the snapshot belongs to, in ms. */
  hourMs: number;
  /** Chain height the LP balance was read at. */
  height: number;
  lpBalance: string;
};

export type RewardRemoval = {
  address: string;
  height: number;
  /** LP burned. Null when the event did not say: treated as a full removal. */
  lpAmount: string | null;
};

export type ShareParams = {
  startMs: number;
  endMs: number;
  minHoldHours: number;
  maxGapHours: number;
  excluded: Iterable<string>;
};

export type AddressShare = { address: string; shareSeconds: bigint };

export type ShareComputation = {
  /** Eligible addresses with share-seconds above zero, sorted by address. */
  eligible: AddressShare[];
  totalShareSeconds: bigint;
  /** Share-seconds of excluded addresses, reported only. */
  excludedShareSeconds: bigint;
  /**
   * Eligible addresses whose latest streak is still open at the end of the
   * data and shorter than the minimum hold, with its hours so far. Only
   * meaningful for an epoch that is still running.
   */
  warmingUp: Map<string, number>;
};

const ZERO = BigInt(0);
const HOUR_MS = 3_600_000;
const DIGITS = /^\d+$/;
const ADDRESS_PATTERN = /^qor1[0-9a-z]{20,}$/;

function big(value: string | null | undefined) {
  return DIGITS.test(value ?? "") ? BigInt(value as string) : ZERO;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function computeShareSeconds(snapshots: RewardSnapshot[], removals: RewardRemoval[], params: ShareParams): ShareComputation {
  if (!(params.endMs > params.startMs)) throw new Error("The epoch window is empty");
  const excluded = new Set([...params.excluded].map((address) => address.toLowerCase()));

  const removalsBy = new Map<string, Array<{ height: number; lp: bigint | null }>>();
  for (const removal of removals) {
    const address = removal.address.toLowerCase();
    pushTo(removalsBy, address, { height: removal.height, lp: DIGITS.test(removal.lpAmount ?? "") ? BigInt(removal.lpAmount as string) : null });
  }
  const positions = new Map<string, RewardSnapshot[]>();
  for (const snapshot of snapshots) {
    const address = snapshot.address.toLowerCase();
    if (!ADDRESS_PATTERN.test(address) || !Number.isFinite(snapshot.hourMs)) continue;
    pushTo(positions, address, snapshot);
  }

  const shares = new Map<string, bigint>();
  const warmingUp = new Map<string, number>();
  for (const [address, list] of [...positions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    list.sort((a, b) => a.hourMs - b.hourMs || a.height - b.height);
    const positionRemovals = removalsBy.get(address) ?? [];
    let streak: Array<{ endMs: number; hours: number; held: bigint }> = [];
    let streakHours = 0;
    let total = ZERO;

    const closeStreak = (open: boolean) => {
      if (streakHours >= params.minHoldHours) {
        for (const interval of streak) {
          const from = Math.max(interval.endMs - interval.hours * HOUR_MS, params.startMs);
          const to = Math.min(interval.endMs, params.endMs);
          if (to > from) total += interval.held * BigInt(Math.floor((to - from) / 1000));
        }
      } else if (open && streakHours > 0) {
        warmingUp.set(address, streakHours);
      }
      streak = [];
      streakHours = 0;
    };

    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      const spanHours = Math.floor((current.hourMs - previous.hourMs) / HOUR_MS);
      if (spanHours <= 0) continue;
      let removed = ZERO;
      let fullRemoval = false;
      for (const removal of positionRemovals) {
        if (removal.height <= previous.height || removal.height > current.height) continue;
        if (removal.lp === null) fullRemoval = true;
        else removed += removal.lp;
      }
      const afterRemovals = big(previous.lpBalance) - removed;
      const later = big(current.lpBalance);
      const held = fullRemoval || afterRemovals <= ZERO ? ZERO : afterRemovals < later ? afterRemovals : later;
      if (held === ZERO) {
        closeStreak(false);
        continue;
      }
      const hours = Math.min(spanHours, params.maxGapHours);
      streak.push({ endMs: current.hourMs, hours, held });
      streakHours += hours;
    }
    closeStreak(true);
    if (total > ZERO) shares.set(address, total);
  }

  const eligible: AddressShare[] = [];
  let totalShareSeconds = ZERO;
  let excludedShareSeconds = ZERO;
  for (const [address, shareSeconds] of shares) {
    if (excluded.has(address)) {
      excludedShareSeconds += shareSeconds;
      continue;
    }
    eligible.push({ address, shareSeconds });
    totalShareSeconds += shareSeconds;
  }
  for (const address of [...warmingUp.keys()]) if (excluded.has(address)) warmingUp.delete(address);
  return { eligible, totalShareSeconds, excludedShareSeconds, warmingUp };
}

export type RewardAllocation = { address: string; shareSeconds: bigint; amount: bigint };

/**
 * Splits `budget` by share-seconds with floor division. Addresses whose
 * amount rounds to zero are left out. `dust` is what stays unallocated.
 */
export function allocateRewards(budget: bigint, shares: AddressShare[]): { allocations: RewardAllocation[]; total: bigint; dust: bigint; totalShareSeconds: bigint } {
  if (budget < ZERO) throw new Error("The budget cannot be negative");
  const totalShareSeconds = shares.reduce((sum, entry) => sum + entry.shareSeconds, ZERO);
  if (totalShareSeconds === ZERO) return { allocations: [], total: ZERO, dust: budget, totalShareSeconds };
  const allocations: RewardAllocation[] = [];
  let total = ZERO;
  for (const entry of [...shares].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))) {
    if (entry.shareSeconds <= ZERO) continue;
    const amount = (budget * entry.shareSeconds) / totalShareSeconds;
    if (amount === ZERO) continue;
    allocations.push({ address: entry.address, shareSeconds: entry.shareSeconds, amount });
    total += amount;
  }
  return { allocations, total, dust: budget - total, totalShareSeconds };
}

/** Share in parts per million, floored. */
export function sharePpm(part: bigint, total: bigint) {
  return total > ZERO ? (part * BigInt(1_000_000)) / total : ZERO;
}

/** Base units as a plain decimal string without trailing zeros. */
export function formatUnits(amount: bigint, decimals: number) {
  const negative = amount < ZERO;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
