import assert from "node:assert/strict";
import test from "node:test";

import { rewardsClaimAction } from "../lib/qwakk-native-rewards";
import { claimActionFor, formatRewardAmount, formatRewardHero, formatTimeLeft, nextRewardClaim, formatRewardRange, formatRewardTime, formatSharePpm, isClaimedQueryPath, parseIsClaimed, parseStageList, rewardClaimState, warmingHoursLeft } from "../lib/qwakk-rewards-view";

const OPEN = "2026-12-01T01:00:00.000Z";
const CLOSE = "2026-12-31T01:00:00.000Z";
const registered = { status: "registered" as const, claimStartsAt: OPEN, claimEndsAt: CLOSE };

test("claim state follows the contract window and the is_claimed answer", () => {
  const inside = Date.parse("2026-12-02T00:00:00Z");
  assert.equal(rewardClaimState(registered, undefined, inside), "claimable");
  assert.equal(rewardClaimState(registered, false, inside), "claimable");
  assert.equal(rewardClaimState(registered, true, inside), "claimed");
  assert.equal(rewardClaimState(registered, false, Date.parse(OPEN) - 1), "upcoming");
  assert.equal(rewardClaimState(registered, false, Date.parse(OPEN)), "claimable");
  // The window is [start, end): the end itself is closed.
  assert.equal(rewardClaimState(registered, false, Date.parse(CLOSE)), "expired");
  assert.equal(rewardClaimState(registered, true, Date.parse(CLOSE) + 1), "claimed");
  assert.equal(rewardClaimState({ ...registered, status: "finalized" }, undefined, inside), "pending");
  assert.equal(rewardClaimState({ ...registered, claimStartsAt: null }, undefined, inside), "upcoming");
});

test("reward amounts are grouped, trimmed and never guessed", () => {
  assert.equal(formatRewardAmount("3000000000000", 6, 0), "3,000,000");
  assert.equal(formatRewardAmount("1234567891", 6), "1,234.56");
  assert.equal(formatRewardAmount("1000000", 6), "1");
  assert.equal(formatRewardAmount("5", 6), "< 0.01");
  assert.equal(formatRewardAmount("0", 6), "0");
  assert.equal(formatRewardAmount("1234", 0), "1,234");
  assert.equal(formatRewardAmount("12", null), null);
  assert.equal(formatRewardAmount("1.5", 6), null);
});

test("share and hours read plainly", () => {
  assert.equal(formatSharePpm("123456"), "12.34%");
  assert.equal(formatSharePpm("1000000"), "100.00%");
  assert.equal(formatSharePpm("50"), "< 0.01%");
  assert.equal(formatSharePpm("0"), "0.00%");
  assert.equal(formatSharePpm("2000000"), null);
  assert.equal(warmingHoursLeft(2, 6), 4);
  assert.equal(warmingHoursLeft(5.5, 6), 1);
  assert.equal(warmingHoursLeft(null, 6), 6);
  assert.equal(formatRewardTime("2026-12-01T00:00:00Z"), "Tue, Dec 1, 00:00 UTC");
  assert.equal(formatRewardTime(null), null);
  assert.equal(formatRewardRange("2026-11-23T00:00:00Z", "2026-11-30T00:00:00Z"), "Nov 23 to Nov 29");
  assert.equal(formatRewardRange("2026-11-30T00:00:00Z", "2026-11-23T00:00:00Z"), null);
});

test("stage lists are bounded and strict", () => {
  assert.deepEqual(parseStageList("1,2,2,3"), [1, 2, 3]);
  assert.equal(parseStageList(null), null);
  assert.equal(parseStageList("0"), null);
  assert.equal(parseStageList("1,,2"), null);
  assert.equal(parseStageList("1;2"), null);
  assert.equal(parseStageList(Array.from({ length: 25 }, (_, index) => index + 1).join(",")), null);
});

test("is_claimed query path is URL-safe base64 of the contract query", () => {
  const address = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const path = isClaimedQueryPath("qor1contract", 7, address);
  assert.match(path, /^\/cosmwasm\/wasm\/v1\/contract\/qor1contract\/smart\/[A-Za-z0-9_-]+=*$/);
  const encoded = path.split("/").pop() ?? "";
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), { is_claimed: { stage_id: 7, address } });
  assert.equal(parseIsClaimed({ data: { claimed: true, amount: "5" } }), true);
  assert.equal(parseIsClaimed({ data: { claimed: false, amount: "0" } }), false);
  assert.equal(parseIsClaimed({ code: 2, message: "boom" }), null);
  assert.equal(parseIsClaimed(null), null);
});

test("the page's claim action matches the native rewards builder", () => {
  const claim = { stageId: 3, amount: "1234567", proof: ["a".repeat(64), "b".repeat(64)] };
  assert.deepEqual(claimActionFor(claim), rewardsClaimAction(claim));
});

test("hero amounts, countdowns and the next claim", () => {
  assert.equal(formatRewardHero("388001230000", 6), "388,001");
  assert.equal(formatRewardHero("999990000", 6), "999.99");
  assert.equal(formatRewardHero("12", null), null);
  const now = Date.parse("2026-11-25T21:00:00Z");
  assert.equal(formatTimeLeft("2026-11-30T00:00:00Z", now), "4d 3h");
  assert.equal(formatTimeLeft("2026-11-25T23:30:00Z", now), "2h 30m");
  assert.equal(formatTimeLeft("2026-11-25T21:05:00Z", now), "5m");
  assert.equal(formatTimeLeft("2026-11-25T20:00:00Z", now), null);
  const claim = (stageId: number, ends: string) => ({ stageId, status: "registered" as const, claimStartsAt: "2026-11-01T00:00:00Z", claimEndsAt: ends });
  const claims = [claim(3, "2026-12-20T00:00:00Z"), claim(2, "2026-12-10T00:00:00Z"), claim(1, "2026-11-20T00:00:00Z")];
  assert.deepEqual(nextRewardClaim(claims, () => undefined, now), { claim: claims[1], open: 2 });
  assert.deepEqual(nextRewardClaim(claims, (entry) => entry.stageId === 2, now), { claim: claims[0], open: 1 });
  assert.deepEqual(nextRewardClaim(claims, () => true, now), { claim: null, open: 0 });
  assert.deepEqual(nextRewardClaim(claims, () => undefined, 0), { claim: null, open: 0 });
});
