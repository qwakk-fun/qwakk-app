import assert from "node:assert/strict";
import test from "node:test";

import {
  chainGuard, databaseNetworkCheck, evaluateIndexerHealth, freshStartHeight, healthConfig, lpSnapshotRule, resolveIndexerNetwork, retentionConfig,
  type SyncState,
} from "../indexer/indexer-config";
import { positionBalances } from "../indexer/positions";
import { curatedToken, quoteRank, resolveTokenInfo } from "../indexer/token-registry";

test("picks QoreChain endpoints by QWAKK_NETWORK, overrides still win", () => {
  assert.deepEqual(resolveIndexerNetwork({}).network, { id: "testnet", chainId: "qorechain-diana", restUrl: "https://api-testnet.qore.host", rpcUrl: "https://rpc-testnet.qore.host" });
  assert.deepEqual(resolveIndexerNetwork({ QWAKK_NETWORK: "mainnet" }).network, { id: "mainnet", chainId: "qorechain-vladi", restUrl: "https://api.qore.host", rpcUrl: "https://rpc.qore.host" });
  const custom = resolveIndexerNetwork({ QWAKK_NETWORK: "mainnet", QORECHAIN_RPC_URL: "https://my-node.example/rpc/" });
  assert.equal(custom.network.rpcUrl, "https://my-node.example/rpc");
  assert.equal(custom.network.restUrl, "https://api.qore.host");
  // A leftover testnet URL after switching to mainnet is ignored, like lib/qwakk-network.ts.
  const leftover = resolveIndexerNetwork({ QWAKK_NETWORK: "mainnet", QORECHAIN_REST_URL: "https://api-testnet.qore.host" });
  assert.equal(leftover.network.restUrl, "https://api.qore.host");
  assert.equal(leftover.warnings.length, 1);
  const typo = resolveIndexerNetwork({ QWAKK_NETWORK: "mainet" });
  assert.equal(typo.network.id, "testnet");
  assert.match(typo.warnings[0], /not testnet or mainnet/);
});

test("curated tokens are per network: mainnet lists only QOR", () => {
  const fusd = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
  assert.equal(curatedToken(fusd, "testnet")?.symbol, "fUSD");
  assert.equal(curatedToken(fusd, "mainnet"), undefined);
  assert.equal(quoteRank(fusd, "mainnet"), null);
  assert.equal(curatedToken("uqor", "mainnet")?.decimals, 6);
  assert.equal(resolveTokenInfo(fusd, undefined, "mainnet").decimals, null);
});

test("the chain id guard never lets one network write into the other's database", () => {
  const base = { configured: "qorechain-vladi", node: "qorechain-vladi", stored: null, databaseHasData: false, adopt: null };
  assert.deepEqual(chainGuard(base), { action: "store", chainId: "qorechain-vladi" });
  assert.deepEqual(chainGuard({ ...base, stored: "qorechain-vladi", databaseHasData: true }), { action: "ok" });
  assert.equal(chainGuard({ ...base, node: "qorechain-diana" }).action, "refuse");
  assert.equal(chainGuard({ ...base, stored: "qorechain-diana", databaseHasData: true }).action, "refuse");
  // An unlabeled database from before the guard holds testnet data unless the owner says otherwise.
  assert.equal(chainGuard({ ...base, databaseHasData: true }).action, "refuse");
  assert.deepEqual(chainGuard({ ...base, databaseHasData: true, adopt: "qorechain-vladi" }), { action: "store", chainId: "qorechain-vladi" });
  assert.deepEqual(chainGuard({ ...base, configured: "qorechain-diana", node: "qorechain-diana", databaseHasData: true }), { action: "store", chainId: "qorechain-diana" });
});

test("health reports height, lag and a stalled or lagging sync as not ok", () => {
  const config = healthConfig({});
  assert.deepEqual(config, { maxLag: 600, maxSyncAgeSeconds: 120 });
  const now = new Date("2026-10-31T20:00:00Z");
  const state: SyncState = { chainId: "qorechain-diana", height: 9236600, chainHeight: 9236634, lastSyncAt: new Date("2026-10-31T19:59:55Z"), lastErrorAt: null, startedAt: new Date("2026-10-31T19:00:00Z") };
  assert.deepEqual(evaluateIndexerHealth(state, config, now), {
    ok: true, status: "ok", chainId: "qorechain-diana", height: "9236600", chainHeight: "9236634", lag: 34, maxLag: 600,
    lastSyncAt: "2026-10-31T19:59:55.000Z", lastErrorAt: null,
  });
  assert.equal(evaluateIndexerHealth({ ...state, height: 9000000 }, config, now).status, "lagging");
  const stalled = evaluateIndexerHealth({ ...state, lastSyncAt: new Date("2026-10-31T19:55:00Z"), lastErrorAt: new Date("2026-10-31T19:59:58Z") }, config, now);
  assert.equal(stalled.ok, false);
  assert.equal(stalled.status, "stalled");
  assert.equal(evaluateIndexerHealth({ ...state, lastSyncAt: null, startedAt: new Date("2026-10-31T19:59:30Z") }, config, now).status, "starting");
  assert.equal(evaluateIndexerHealth({ ...state, lastSyncAt: null }, config, now).status, "stalled");
});

test("retention defaults are safe, configurable and can be switched off", () => {
  assert.deepEqual(retentionConfig({}), { enabled: true, intervalMinutes: 60, candles1mDays: 7, candles5mDays: 14, swapRawEventDays: 30, lpSnapshotDays: 90 });
  assert.equal(retentionConfig({ QWAKK_RETENTION: "off" }).enabled, false);
  assert.equal(retentionConfig({ QWAKK_RETENTION_CANDLES_1M_DAYS: "0" }).candles1mDays, 0);
  // Never below the window the API serves (1m: 24 hours, 5m: 3 days).
  const warnings: string[] = [];
  const clamped = retentionConfig({ QWAKK_RETENTION_CANDLES_1M_DAYS: "1", QWAKK_RETENTION_CANDLES_5M_DAYS: "2", QWAKK_RETENTION_SWAP_RAW_EVENT_DAYS: "soon" }, warnings);
  assert.equal(clamped.candles1mDays, 2);
  assert.equal(clamped.candles5mDays, 4);
  assert.equal(clamped.swapRawEventDays, 30);
  assert.equal(warnings.length, 3);
});

test("a fresh database starts at the configured height, else the first pool, else the tip", () => {
  assert.equal(freshStartHeight({ configured: 9003548, currentHeight: 9237000, earliestHeight: 8790799, firstPoolHeight: 9003548 }), 9003547);
  assert.equal(freshStartHeight({ configured: 0, currentHeight: 9237000, earliestHeight: 8790799, firstPoolHeight: 9003548 }), 9003547);
  assert.equal(freshStartHeight({ configured: 0, currentHeight: 9237000, earliestHeight: 8790799, firstPoolHeight: 100 }), 8790798);
  // Mainnet keeps every block and has no pools yet: start at the tip.
  assert.equal(freshStartHeight({ configured: 0, currentHeight: 3952138, earliestHeight: 1, firstPoolHeight: null }), 3952138);
  assert.equal(freshStartHeight({ configured: 1, currentHeight: 3952138, earliestHeight: 1, firstPoolHeight: null }), 0);
});

test("LP positions combine the latest snapshot with later events", () => {
  // Pool 1 on Diana, the creator: minted 1000000, burned 1000000, minted 1000022.
  const creatorEvents = [
    { poolId: "1", eventType: "pool_created", lpAmount: "1000000", height: 9003548 },
    { poolId: "1", eventType: "liquidity_removed", lpAmount: "1000000", height: 9005095 },
    { poolId: "1", eventType: "liquidity_added", lpAmount: "1000022", height: 9005181 },
  ];
  assert.deepEqual(positionBalances(creatorEvents, []), [{ poolId: "1", lpBalance: "1000022", source: "events", asOfHeight: 9005181 }]);
  assert.deepEqual(positionBalances(creatorEvents, [{ poolId: "1", height: 9005100, lpBalance: "0" }]), [{ poolId: "1", lpBalance: "1000022", source: "snapshot_and_events", asOfHeight: 9005181 }]);
  assert.deepEqual(positionBalances(creatorEvents, [{ poolId: "1", height: 9006000, lpBalance: "1000022" }, { poolId: "1", height: 9005000, lpBalance: "5" }]), [{ poolId: "1", lpBalance: "1000022", source: "snapshot", asOfHeight: 9006000 }]);
  // Closed positions are left out; an event without an LP amount makes the balance unknown.
  const trader = [
    { poolId: "1", eventType: "liquidity_added", lpAmount: "4900", height: 9003943 },
    { poolId: "1", eventType: "liquidity_removed", lpAmount: "2450", height: 9004088 },
    { poolId: "1", eventType: "liquidity_removed", lpAmount: "2450", height: 9004134 },
    { poolId: "2", eventType: "liquidity_added", lpAmount: null, height: 9100000 },
  ];
  assert.deepEqual(positionBalances(trader, []), [{ poolId: "2", lpBalance: null, source: "incomplete", asOfHeight: 9100000 }]);
});

test("a configured points season protects its LP snapshots even while points are off", () => {
  // A private season starting at 9003548 runs longer than the 90 day window: only snapshots below it may go.
  assert.deepEqual(lpSnapshotRule(9003548, 90), { kind: "below_height", height: 9003548 });
  assert.deepEqual(lpSnapshotRule(9003548, 0), { kind: "below_height", height: 9003548 });
  // No season: the rolling window, or nothing when it is switched off.
  assert.deepEqual(lpSnapshotRule(0, 90), { kind: "older_than_days", days: 90 });
  assert.equal(lpSnapshotRule(0, 0), null);
});

test("the candle rebuild refuses a database from another network or without a label", () => {
  assert.deepEqual(databaseNetworkCheck({ configured: "qorechain-diana", stored: "qorechain-diana", assumed: null }), { ok: true });
  assert.equal(databaseNetworkCheck({ configured: "qorechain-vladi", stored: "qorechain-diana", assumed: null }).ok, false);
  // A wrong --assume-chain-id never overrides a stored label.
  assert.equal(databaseNetworkCheck({ configured: "qorechain-vladi", stored: "qorechain-diana", assumed: "qorechain-vladi" }).ok, false);
  assert.equal(databaseNetworkCheck({ configured: "qorechain-diana", stored: null, assumed: null }).ok, false);
  assert.deepEqual(databaseNetworkCheck({ configured: "qorechain-diana", stored: null, assumed: "qorechain-diana" }), { ok: true });
  assert.equal(databaseNetworkCheck({ configured: "qorechain-vladi", stored: null, assumed: "qorechain-diana" }).ok, false);
});
