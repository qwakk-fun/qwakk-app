/**
 * In-memory, per-client-IP token buckets for Qwakk's API routes.
 *
 * Qwakk runs from one server IP, and every chain read it relays counts against
 * that IP at the public QoreChain REST endpoint. One aggressive client must not
 * be able to get that IP throttled for everyone, so the routes that fan out to
 * the chain get small budgets and the cached, cheap routes get large ones.
 *
 * State lives in the web process. With several web replicas each replica keeps
 * its own buckets, so the effective budget is multiplied by the replica count.
 * The CapRover nginx `limit_req` layer (see README) is the shared outer limit.
 */

export type RateLimitBudget = {
  /** Requests a client may make in a burst. */
  capacity: number;
  /** Requests a client regains per minute once the burst is spent. */
  refillPerMinute: number;
};

export type RateLimitRule = {
  name: string;
  budget: RateLimitBudget;
  /** Path prefixes this rule covers. The first matching rule wins. */
  prefixes: readonly string[];
};

/**
 * Budgets are per client IP and per rule.
 *
 * - tx-build: each prepare or probe makes about six upstream calls (account,
 *   PQC key, pools, simulate, balances). A person signs one action at a time.
 * - positions: one pool list plus one LP read per pool (up to 50). Loaded once
 *   per profile visit and after a confirmed transaction; results are cached.
 * - tx-status: polled every 2 s while a transaction confirms (30 a minute).
 * - quote: debounced while typing plus a refresh every 15 s.
 * - chain-read: wallet balances, history, wallet PnL, pool and asset reads.
 *   One to a few upstream calls each (PnL: one bank read plus an indexer
 *   replay of the wallet's swaps), polled at most every 15 s. Rewards reads
 *   too: a claimed check fans out to up to 24 contract queries (4 at a time).
 * - api: everything else. Network, markets and activity are served from short
 *   server caches, so a client hammering them costs no extra upstream calls.
 *   The home page polls about 25 times a minute per open tab.
 */
export const QWAKK_RATE_LIMIT_RULES: readonly RateLimitRule[] = [
  { name: "tx-build", prefixes: ["/api/native-tx/prepare", "/api/native-tx/probe"], budget: { capacity: 10, refillPerMinute: 12 } },
  { name: "positions", prefixes: ["/api/positions"], budget: { capacity: 5, refillPerMinute: 4 } },
  { name: "tx-status", prefixes: ["/api/native-tx/status"], budget: { capacity: 30, refillPerMinute: 40 } },
  { name: "quote", prefixes: ["/api/swap-quote"], budget: { capacity: 30, refillPerMinute: 30 } },
  { name: "chain-read", prefixes: ["/api/account", "/api/transactions", "/api/pnl", "/api/native/", "/api/rewards"], budget: { capacity: 40, refillPerMinute: 60 } },
  { name: "api", prefixes: ["/api/"], budget: { capacity: 120, refillPerMinute: 240 } },
];

/** Never limited: the container health check calls it locally with no client IP. */
const EXEMPT_PATHS = new Set(["/api/health"]);

function matchesPrefix(pathname: string, prefix: string) {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The rule for a request path, or null when the path is not rate limited. */
export function rateLimitRuleFor(pathname: string, rules: readonly RateLimitRule[] = QWAKK_RATE_LIMIT_RULES): RateLimitRule | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (EXEMPT_PATHS.has(path)) return null;
  return rules.find((rule) => rule.prefixes.some((prefix) => matchesPrefix(path, prefix))) ?? null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function expandIpv6(address: string): string[] | null {
  if (!/^[0-9a-f:.]+$/.test(address) || address.split("::").length > 2) return null;
  const [head, tail = ""] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  // A trailing embedded IPv4 (::ffff:1.2.3.4) takes two groups.
  const last = tailParts.length ? tailParts : headParts;
  if (last.length && IPV4.test(last[last.length - 1])) {
    const octets = last.pop()!.split(".").map(Number);
    last.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (address.includes("::") ? missing < 1 : missing !== 0) return null;
  const groups = [...headParts, ...Array<string>(address.includes("::") ? missing : 0).fill("0"), ...tailParts];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, ""));
}

/**
 * Normalizes one address into a bucket key. IPv6 clients are grouped by their
 * /64, because a single subscriber usually controls a whole /64 and could
 * otherwise rotate through addresses to reset its budget.
 */
export function clientKeyFromAddress(raw: string): string {
  let address = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  address = address.replace(/%.*$/, "");

  if (IPV4.test(address)) return address;
  const groups = expandIpv6(address);
  if (!groups) return "invalid";
  const mappedV4 = groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff";
  if (mappedV4) {
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * The client address as seen by the trusted reverse proxy.
 *
 * CapRover's nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which
 * appends the TCP peer address it actually saw to whatever the client sent.
 * Only the entries appended by proxies we run are trustworthy, so the client
 * is read `trustedHops` entries from the right, never from the left. With
 * CapRover alone that is the last entry. With one more trusted proxy in front
 * (for example Cloudflare) it is the second to last. `X-Real-IP` (set by
 * CapRover to the peer address) is the fallback.
 *
 * Without either header (local `npm start`, tests) every request shares the
 * "unknown" bucket. Never expose the container port directly to the internet:
 * a direct client could then write its own X-Forwarded-For.
 */
export function clientIpFromHeaders(headers: Headers, trustedHops = 1): string {
  const hops = Math.max(1, Math.floor(trustedHops) || 1);
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (forwarded.length) return clientKeyFromAddress(forwarded[Math.max(0, forwarded.length - hops)]);
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return clientKeyFromAddress(realIp);
  return "unknown";
}

export type RateLimitDecision = {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until the next request would be allowed (0 when allowed). */
  retryAfterSeconds: number;
};

type Bucket = { tokens: number; updatedAt: number; capacity: number; ratePerMs: number };

/**
 * A token bucket store with a hard key limit. Recently used keys are kept, the
 * least recently used are dropped first, and idle full buckets are pruned.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune = 0;

  constructor(private readonly options: { maxKeys?: number; pruneIntervalMs?: number } = {}) {}

  get size() {
    return this.buckets.size;
  }

  take(key: string, budget: RateLimitBudget, now = Date.now()): RateLimitDecision {
    this.prune(now);
    const capacity = Math.max(1, budget.capacity);
    const ratePerMs = Math.max(budget.refillPerMinute, 0.001) / 60_000;
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: now, capacity, ratePerMs };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * ratePerMs);
    bucket.updatedAt = now;
    bucket.capacity = capacity;
    bucket.ratePerMs = ratePerMs;

    // Reinsert so Map order stays least recently used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    const maxKeys = this.options.maxKeys ?? 50_000;
    while (this.buckets.size > maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000)) };
  }

  private prune(now: number) {
    const interval = this.options.pruneIntervalMs ?? 60_000;
    if (now - this.lastPrune < interval) return;
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      const full = bucket.tokens + (now - bucket.updatedAt) * bucket.ratePerMs >= bucket.capacity;
      if (full) this.buckets.delete(key);
    }
  }
}

/** `QWAKK_RATE_LIMIT=off` disables the limiter (for example during an incident with a misconfigured proxy). */
export function rateLimitEnabled(value = process.env.QWAKK_RATE_LIMIT) {
  return !/^(off|false|0|disabled)$/i.test(value?.trim() ?? "");
}

/** `QWAKK_TRUSTED_PROXY_HOPS`: reverse proxies in front of the app that append to X-Forwarded-For. Default 1 (CapRover nginx). */
export function trustedProxyHops(value = process.env.QWAKK_TRUSTED_PROXY_HOPS) {
  const hops = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(hops) && hops >= 1 && hops <= 5 ? hops : 1;
}

export const RATE_LIMITED_COPY = "Too many requests from your connection. Wait a few seconds and try again.";

/** A JSON 429 with Retry-After. */
export function rateLimitedResponse(decision: RateLimitDecision) {
  return Response.json(
    { error: RATE_LIMITED_COPY },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    },
  );
}
