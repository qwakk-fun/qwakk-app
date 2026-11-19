import assert from "node:assert/strict";
import test from "node:test";

import { FAVORITES_KEY, MAX_FAVORITES, favoritesFor, parseFavorites, readFavoritesRaw, saveFavoriteToggle, toggleFavorite } from "../lib/qwakk-favorites";
import { sparkPoints, sparkSummary } from "../lib/qwakk-chart";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("uses a qwakk- storage key", () => {
  assert.match(FAVORITES_KEY, /^qwakk-/);
});

test("toggles pools per network, newest first", () => {
  let store = toggleFavorite({}, "testnet", "6");
  store = toggleFavorite(store, "testnet", 1);
  store = toggleFavorite(store, "mainnet", "6");
  assert.deepEqual(favoritesFor(store, "testnet"), ["1", "6"]);
  assert.deepEqual(favoritesFor(store, "mainnet"), ["6"]);
  store = toggleFavorite(store, "testnet", "6");
  assert.deepEqual(favoritesFor(store, "testnet"), ["1"]);
  // Removing the last one drops the network entry.
  assert.deepEqual(toggleFavorite(store, "mainnet", "6"), { testnet: ["1"] });
  // The network must be known; an unknown one reads as none.
  assert.deepEqual(favoritesFor(store, null), []);
});

test("ignores bad ids and caps the list", () => {
  assert.deepEqual(toggleFavorite({}, "testnet", "abc"), {});
  assert.deepEqual(toggleFavorite({}, "Bad Net", "1"), {});
  let store = {};
  for (let id = 0; id < MAX_FAVORITES + 5; id += 1) store = toggleFavorite(store, "testnet", id);
  assert.equal(favoritesFor(store, "testnet").length, MAX_FAVORITES);
  assert.equal(favoritesFor(store, "testnet")[0], String(MAX_FAVORITES + 4));
});

test("parses stored values defensively", () => {
  assert.deepEqual(parseFavorites(null), {});
  assert.deepEqual(parseFavorites("not json"), {});
  assert.deepEqual(parseFavorites("[1,2]"), {});
  assert.deepEqual(parseFavorites(JSON.stringify({ testnet: ["6", 6, "6", "x", 1, null], "<script>": ["1"], mainnet: "6" })), { testnet: ["6", "1"] });
});

test("saves through storage and keeps another tab's change", () => {
  const storage = new MemoryStorage();
  assert.equal(saveFavoriteToggle(storage, "testnet", "6"), true);
  // Another tab adds pool 2 meanwhile.
  storage.setItem(FAVORITES_KEY, JSON.stringify({ testnet: ["2", "6"] }));
  assert.equal(saveFavoriteToggle(storage, "testnet", "1"), true);
  assert.deepEqual(parseFavorites(readFavoritesRaw(storage)), { testnet: ["1", "2", "6"] });
});

test("blocked storage fails quietly", () => {
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  assert.equal(readFavoritesRaw(blocked), null);
  assert.equal(readFavoritesRaw(null), null);
  assert.equal(saveFavoriteToggle(blocked, "testnet", "6"), false);
  assert.equal(saveFavoriteToggle(null, "testnet", "6"), false);
});

test("sparkline points hold quiet hours at the last price", () => {
  const now = Date.parse("2026-11-19T12:30:00Z");
  const candle = (time: string, close: number) => ({ start_time: time, open: close, high: close, low: close, close });
  const points = sparkPoints([candle("2026-11-19T09:00:00Z", 1), candle("2026-11-19T11:00:00Z", 2)], 24, now);
  assert.deepEqual(points.map((point) => point.price), [1, 1, 2, 2]);
  // One trade this hour is not a line yet.
  assert.deepEqual(sparkPoints([candle("2026-11-19T12:00:00Z", 1)], 24, now), []);
  // Only the last day (plus the current hour) is kept.
  assert.equal(sparkPoints([candle("2026-11-10T00:00:00Z", 1)], 24, now).length, 25);
});

test("says a pool was quiet only when no candle touches the window", () => {
  const now = Date.parse("2026-11-19T12:30:00Z");
  const candle = (time: string, close: number) => ({ start_time: time, open: close, high: close, low: close, close });
  // A first trade this hour: no line yet, but it did trade.
  assert.deepEqual(sparkSummary([candle("2026-11-19T12:00:00Z", 1)], 24, now), { points: [], traded: true });
  // Last trade two days ago: a flat line at that price, and no trades in the window.
  const old = sparkSummary([candle("2026-11-17T10:00:00Z", 3)], 24, now);
  assert.equal(old.traded, false);
  assert.equal(old.points.length, 25);
  // The bucket that ends just after the cutoff still counts.
  assert.equal(sparkSummary([candle("2026-11-18T12:00:00Z", 1)], 24, now).traded, true);
  assert.deepEqual(sparkSummary([], 24, now), { points: [], traded: false });
});
