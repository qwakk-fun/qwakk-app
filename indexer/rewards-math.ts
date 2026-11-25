/**
 * Time-weighted LP share for Qwakk liquidity rewards. Pure and deterministic:
 * the same snapshots, removals and parameters always give the same result.
 *
 * Inputs are the hourly LP balance snapshots of one pool (read from the
 * chain's LP balance query, /qorechain/amm/v1/pools/{id}/lp/{address}) and
 * the pool's liquidity removal events. LP shares cannot be transferred, so an
 * address's balance only changes through its own adds and removals.
 *
 * Holding rule: between two consecutive snapshots of one position, the
 * amount held through the whole interval is the earlier balance minus
 * everything removed in between, capped by the later balance (as in the
 * points program). Adds in between are not held until the next interval, and
 * a removal without a readable LP amount counts as a full removal. A gap
 * longer than `maxGapHours` is credited for its last `maxGapHours` only.
 *
 * Minimum hold: an interval is credited with the smallest amount held over
 * the trailing window that starts `minHoldHours` before the credited time and
 * ends with the interval. So every LP unit earns only once it has itself been
 * held `minHoldHours`: a large deposit next to a small long-held position
 * earns nothing extra until it has waited too, add-then-remove gaming earns
 * nothing, and the warm-up hours never earn in any epoch (they are not lost
 * or gained by when an epoch is finalized). A window that reaches before the
 * address's first snapshot in the data is not covered and earns nothing, so
 * callers read at least `minHoldHours + maxGapHours` before the epoch start.
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
   * Eligible addresses holding LP at the end of the data with nothing
   * credited yet (still inside the minimum hold), with the hours held so far.
   * Only meaningful for an epoch that is still running.
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

  const minHoldMs = params.minHoldHours * HOUR_MS;
  const shares = new Map<string, bigint>();
  const warmingUp = new Map<string, number>();
  for (const [address, list] of [...positions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    list.sort((a, b) => a.hourMs - b.hourMs || a.height - b.height);
    const positionRemovals = removalsBy.get(address) ?? [];

    // Contiguous intervals between consecutive snapshots, with the amount held through each.
    const intervals: Array<{ startMs: number; endMs: number; held: bigint }> = [];
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (current.hourMs <= previous.hourMs) continue;
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
      intervals.push({ startMs: previous.hourMs, endMs: current.hourMs, held });
    }
    if (!intervals.length) continue;
    const coveredFrom = intervals[0].startMs;

    let total = ZERO;
    let lastCredited = ZERO;
    for (let index = 0; index < intervals.length; index += 1) {
      const interval = intervals[index];
      const spanHours = Math.floor((interval.endMs - interval.startMs) / HOUR_MS);
      const creditedStart = interval.endMs - Math.min(spanHours, params.maxGapHours) * HOUR_MS;
      const windowStart = creditedStart - minHoldMs;
      let credited = ZERO;
      if (interval.held > ZERO && windowStart >= coveredFrom) {
        credited = interval.held;
        for (let back = index - 1; back >= 0 && intervals[back].endMs > windowStart && credited > ZERO; back -= 1) {
          if (intervals[back].held < credited) credited = intervals[back].held;
        }
      }
      lastCredited = credited;
      if (credited === ZERO) continue;
      const from = Math.max(creditedStart, params.startMs);
      const to = Math.min(interval.endMs, params.endMs);
      if (to > from) total += credited * BigInt(Math.floor((to - from) / 1000));
    }

    // Still waiting: holding at the end of the data, but nothing credited yet.
    const last = intervals[intervals.length - 1];
    if (last.held > ZERO && lastCredited === ZERO) {
      let heldSinceMs = last.startMs;
      for (let back = intervals.length - 2; back >= 0 && intervals[back].held > ZERO; back -= 1) heldSinceMs = intervals[back].startMs;
      warmingUp.set(address, Math.floor((last.endMs - heldSinceMs) / HOUR_MS));
    }
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
