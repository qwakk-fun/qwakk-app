import assert from "node:assert/strict";
import test from "node:test";
import {
  QWAKK_RATE_LIMIT_RULES,
  TokenBucketLimiter,
  clientIpFromHeaders,
  clientKeyFromAddress,
  rateLimitEnabled,
  rateLimitRuleFor,
  trustedProxyHops,
} from "../lib/qwakk-rate-limit";
import { createServerCache } from "../lib/qwakk-server-cache";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

test("reads the client from the right end of X-Forwarded-For", () => {
  // CapRover nginx appends the peer it saw; anything to the left is client supplied.
  assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
  assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  // One more trusted proxy in front (for example Cloudflare).
  assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4, 172.68.1.1" }), 2), "198.51.100.4");
  // Fewer entries than hops: the peer nginx saw is still the best answer.
  assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.4" }), 2), "198.51.100.4");
  assert.equal(clientIpFromHeaders(headers({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
  assert.equal(clientIpFromHeaders(headers({})), "unknown");
  assert.equal(clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4, not-an-ip" })), "invalid");
});

test("normalizes addresses and groups IPv6 by /64", () => {
  assert.equal(clientKeyFromAddress("203.0.113.9:51234"), "203.0.113.9");
  assert.equal(clientKeyFromAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKeyFromAddress("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(clientKeyFromAddress("[2001:DB8:1:2:bbbb:cccc:dddd:eeee]:443"), "2001:db8:1:2::/64");
  assert.equal(clientKeyFromAddress("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKeyFromAddress("::1"), "0:0:0:0::/64");
  assert.equal(clientKeyFromAddress("999.1.1.1"), "invalid");
});

test("maps routes to budgets and exempts the health check", () => {
  assert.equal(rateLimitRuleFor("/api/health"), null);
  assert.equal(rateLimitRuleFor("/swap"), null);
  assert.equal(rateLimitRuleFor("/api/native-tx/prepare")?.name, "tx-build");
  assert.equal(rateLimitRuleFor("/api/native-tx/probe/")?.name, "tx-build");
  assert.equal(rateLimitRuleFor("/api/native-tx/status")?.name, "tx-status");
  assert.equal(rateLimitRuleFor("/api/positions")?.name, "positions");
  assert.equal(rateLimitRuleFor("/api/positionsx")?.name, "api");
  assert.equal(rateLimitRuleFor("/api/native/pool")?.name, "chain-read");
  assert.equal(rateLimitRuleFor("/api/account")?.name, "chain-read");
  assert.equal(rateLimitRuleFor("/api/pnl")?.name, "chain-read");
  assert.equal(rateLimitRuleFor("/api/swap-quote")?.name, "quote");
  assert.equal(rateLimitRuleFor("/api/network")?.name, "api");
  assert.equal(rateLimitRuleFor("/api/activity")?.name, "api");
});

function rule(name: string) {
  const found = QWAKK_RATE_LIMIT_RULES.find((entry) => entry.name === name);
  assert.ok(found);
  return found.budget;
}

test("a burst on prepare or positions is cut off after the budget", () => {
  for (const name of ["tx-build", "positions"]) {
    const limiter = new TokenBucketLimiter();
    const budget = rule(name);
    const now = 1_000_000;
    for (let index = 0; index < budget.capacity; index += 1) {
      assert.equal(limiter.take("bot", budget, now).allowed, true);
    }
    const blocked = limiter.take("bot", budget, now);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);
    // Another client is not affected.
    assert.equal(limiter.take("person", budget, now).allowed, true);
    // The budget comes back over time.
    assert.equal(limiter.take("bot", budget, now + blocked.retryAfterSeconds * 1000).allowed, true);
  }
});

test("normal UI polling never trips the shared API budget", () => {
  const limiter = new TokenBucketLimiter();
  const budget = rule("api");
  // Three open tabs for an hour: network every 10 s, markets every 15 s and
  // 30 s, activity every 12 s and 20 s, QOR price twice a minute.
  const perTabPerMinute = 6 + 4 + 2 + 5 + 3 + 2;
  const perMinute = perTabPerMinute * 3;
  for (let minute = 0; minute < 60; minute += 1) {
    for (let call = 0; call < perMinute; call += 1) {
      const now = minute * 60_000 + Math.floor((call * 60_000) / perMinute);
      assert.equal(limiter.take("tabs", budget, now).allowed, true);
    }
  }
});

test("status polling during confirmation fits its budget", () => {
  const limiter = new TokenBucketLimiter();
  const budget = rule("tx-status");
  for (let second = 0; second < 300; second += 2) {
    assert.equal(limiter.take("wallet", budget, second * 1000).allowed, true);
  }
});

test("keeps the bucket store bounded", () => {
  const limiter = new TokenBucketLimiter({ maxKeys: 100 });
  for (let index = 0; index < 1_000; index += 1) limiter.take(`client-${index}`, { capacity: 5, refillPerMinute: 5 }, 0);
  assert.equal(limiter.size, 100);
});

test("reads the kill switch and proxy hop settings", () => {
  assert.equal(rateLimitEnabled(undefined), true);
  assert.equal(rateLimitEnabled(""), true);
  assert.equal(rateLimitEnabled("off"), false);
  assert.equal(trustedProxyHops(undefined), 1);
  assert.equal(trustedProxyHops("2"), 2);
  assert.equal(trustedProxyHops("0"), 1);
  assert.equal(trustedProxyHops("abc"), 1);
});

test("the server cache shares one upstream read across concurrent callers", async () => {
  let calls = 0;
  const cache = createServerCache<number>({ ttlMs: () => 60_000 });
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 42;
  };
  const values = await Promise.all(Array.from({ length: 20 }, () => cache("key", load)));
  assert.deepEqual(new Set(values), new Set([42]));
  assert.equal(await cache("key", load), 42);
  assert.equal(calls, 1);
});
