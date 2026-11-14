import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hexToBytes, type Hex } from "viem";
import { checkRegisteredKey, type KeyStatusAnswer } from "../src/keycheck.ts";

const file = JSON.parse(readFileSync(new URL("../../test/fixtures/pq-vectors.json", import.meta.url), "utf8")) as { pubkeyA: Hex; pubkeyB: Hex };
const derived = hexToBytes(file.pubkeyA);
const registered = (over: Partial<KeyStatusAnswer> = {}): KeyStatusAnswer => ({
  registered: true,
  algorithmId: 1,
  pubkey: file.pubkeyA,
  possessionProven: true,
  ...over,
});

test("accepts the mnemonic's own key, registered with a proof of possession", () => {
  assert.deepEqual(checkRegisteredKey(registered(), derived, "0xabc"), { ok: true });
  // Hex case from the node does not matter.
  assert.deepEqual(checkRegisteredKey(registered({ pubkey: file.pubkeyA.toUpperCase().replace("0X", "0x") as Hex }), derived, "0xabc"), { ok: true });
});

test("refuses a different registered key, so deploy and register stop", () => {
  const r = checkRegisteredKey(registered({ pubkey: file.pubkeyB }), derived, "0xabc");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.problem, "different-key");
    assert.match(r.message, /different ML-DSA-87 key/);
  }
});

test("refuses a missing key, another algorithm and a key without proof of possession", () => {
  const problem = (over: Partial<KeyStatusAnswer>) => {
    const r = checkRegisteredKey(registered(over), derived, "0xabc");
    return r.ok ? "ok" : r.problem;
  };
  assert.equal(problem({ registered: false, algorithmId: 0, pubkey: "0x", possessionProven: false }), "not-registered");
  assert.equal(problem({ algorithmId: 2 }), "wrong-algorithm");
  assert.equal(problem({ possessionProven: false }), "no-possession-proof");
  // A mismatch is reported before the missing proof: it is the harder problem to fix.
  assert.equal(problem({ pubkey: file.pubkeyB, possessionProven: false }), "different-key");
});

test("messages never contain an em dash", () => {
  for (const over of [{ registered: false }, { algorithmId: 2 }, { pubkey: file.pubkeyB }, { possessionProven: false }] as Partial<KeyStatusAnswer>[]) {
    const r = checkRegisteredKey(registered(over), derived, "0xabc");
    if (!r.ok) assert.doesNotMatch(r.message, /\u2014/);
  }
});
