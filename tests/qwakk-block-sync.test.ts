import assert from "node:assert/strict";
import test from "node:test";

import { ensurePoolStored, indexBlockRange, isNotFoundAnswer, type ChainLookup } from "../indexer/block-sync";

/** In-memory stand-ins for the pools table, the chain pool query and indexer_state. */
function fakeIndexer(chainAnswers: Array<"down" | "found" | "missing">) {
  const storedPools = new Set<string>();
  const swaps: Array<{ height: number; poolId: string }> = [];
  let savedHeight = 100;
  let lookups = 0;

  const store = {
    isStored: async (poolId: string) => storedPools.has(poolId),
    fetchPool: async (poolId: string): Promise<ChainLookup<string>> => {
      const answer = chainAnswers[Math.min(lookups, chainAnswers.length - 1)];
      lookups += 1;
      if (answer === "down") throw new Error("QoreChain request failed with 503");
      return answer === "found" ? { status: "found", value: poolId } : { status: "missing" };
    },
    persist: async (poolId: string) => {
      storedPools.add(poolId);
    },
  };

  // Block 102 carries the first swap of pool 9, created inside the block range.
  const processBlock = async (height: number) => {
    if (height !== 102) return;
    if (!await ensurePoolStored("9", store)) return;
    swaps.push({ height, poolId: "9" });
  };

  const tick = async (until: number) => {
    try {
      await indexBlockRange(savedHeight, until, { processBlock, saveHeight: async (height) => { savedHeight = height; } });
    } catch {
      // The indexer logs the failure and tries again on the next tick.
    }
  };
  return { tick, swaps, height: () => savedHeight };
}

test("a transient pool lookup failure stops the range and the block is retried, nothing skipped", async () => {
  const indexer = fakeIndexer(["down", "found"]);
  await indexer.tick(105);
  assert.equal(indexer.height(), 101, "block 102 must not be marked as indexed");
  assert.deepEqual(indexer.swaps, []);

  await indexer.tick(105);
  assert.equal(indexer.height(), 105);
  assert.deepEqual(indexer.swaps, [{ height: 102, poolId: "9" }]);
});

test("only a positive not-found answer drops the event and lets the range continue", async () => {
  const indexer = fakeIndexer(["missing"]);
  await indexer.tick(105);
  assert.equal(indexer.height(), 105);
  assert.deepEqual(indexer.swaps, []);
});

test("recognises not-found answers from the QoreChain gateway", () => {
  assert.equal(isNotFoundAnswer(404, null), true);
  assert.equal(isNotFoundAnswer(500, { code: 5, message: "pool 9 not found" }), true);
  assert.equal(isNotFoundAnswer(500, { code: 2, message: "internal" }), false);
  assert.equal(isNotFoundAnswer(503, null), false);
  assert.equal(isNotFoundAnswer(429, { code: 8 }), false);
});
