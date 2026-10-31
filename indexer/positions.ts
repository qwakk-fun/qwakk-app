/**
 * An address's LP positions from indexed data, so the web does not have to
 * ask the chain about every pool. LP shares cannot be transferred, so only
 * the address's own liquidity events change its balance.
 *
 * Per pool: the latest hourly LP snapshot (read from the chain's LP balance
 * query) plus the LP minted and burned by the address's events after that
 * snapshot's height. Without a snapshot, the sum of all the address's events.
 */

export type PositionEvent = {
  poolId: string;
  eventType: string;
  /** LP minted (pool_created, liquidity_added) or burned (liquidity_removed). Null when the event did not say. */
  lpAmount: string | null;
  height: number;
};

export type PositionSnapshot = { poolId: string; height: number; lpBalance: string };

export type PositionSource = "snapshot" | "snapshot_and_events" | "events" | "incomplete";

export type PositionBalance = {
  poolId: string;
  /** Null when an event without an LP amount makes the balance unknown; read that pool from the chain. */
  lpBalance: string | null;
  source: PositionSource;
  /** Highest block height the balance accounts for. */
  asOfHeight: number;
};

function signedAmount(event: PositionEvent) {
  if (event.lpAmount === null || !/^\d+$/.test(event.lpAmount)) return null;
  const amount = BigInt(event.lpAmount);
  if (event.eventType === "liquidity_removed") return -amount;
  if (event.eventType === "pool_created" || event.eventType === "liquidity_added") return amount;
  return BigInt(0);
}

/** Open positions (balance above zero, or unknown) per pool, ordered by pool id. */
export function positionBalances(events: PositionEvent[], snapshots: PositionSnapshot[]): PositionBalance[] {
  const latest = new Map<string, PositionSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.poolId);
    if (!current || snapshot.height > current.height) latest.set(snapshot.poolId, snapshot);
  }
  const pools = new Set([...latest.keys(), ...events.map((event) => event.poolId)]);
  const positions: PositionBalance[] = [];
  for (const poolId of pools) {
    const snapshot = latest.get(poolId);
    const after = events.filter((event) => event.poolId === poolId && (!snapshot || event.height > snapshot.height));
    let balance: bigint | null = snapshot && /^\d+$/.test(snapshot.lpBalance) ? BigInt(snapshot.lpBalance) : snapshot ? null : BigInt(0);
    for (const event of after) {
      const change = signedAmount(event);
      balance = balance === null || change === null ? null : balance + change;
    }
    const asOfHeight = Math.max(snapshot?.height ?? 0, ...after.map((event) => event.height));
    if (balance === null) {
      positions.push({ poolId, lpBalance: null, source: "incomplete", asOfHeight });
      continue;
    }
    if (balance <= BigInt(0)) continue;
    const source: PositionSource = snapshot ? (after.length ? "snapshot_and_events" : "snapshot") : "events";
    positions.push({ poolId, lpBalance: balance.toString(), source, asOfHeight });
  }
  return positions.sort((a, b) => Number(a.poolId) - Number(b.poolId));
}
