/**
 * Display rules for liquidity rewards, shared by the pool page card and the
 * portfolio section. Amounts stay base-unit strings until they are formatted
 * here; nothing converts them through a float.
 */
import type { RewardsClaimAction } from "./qwakk-native-rewards";
import type { QwakkRewardClaim } from "./qwakk-rewards";

/** Where one finalized allocation stands for the connected wallet. */
export type RewardClaimState =
  /** Finalized by Qwakk, not yet registered with the contract. */
  | "pending"
  /** Registered, claim window not open yet. */
  | "upcoming"
  | "claimable"
  | "claimed"
  /** The claim window closed before this wallet claimed. */
  | "expired";

/**
 * `claimed` is the contract's `is_claimed` answer for this stage: true, false,
 * or undefined while it is unknown. Unknown never hides a claim: the contract
 * itself refuses a second claim in simulation, before QoreX opens.
 */
export function rewardClaimState(claim: Pick<QwakkRewardClaim, "status" | "claimStartsAt" | "claimEndsAt">, claimed: boolean | undefined, now: number): RewardClaimState {
  if (claimed === true) return "claimed";
  if (claim.status !== "registered") return "pending";
  const opens = claim.claimStartsAt ? Date.parse(claim.claimStartsAt) : Number.NaN;
  const closes = claim.claimEndsAt ? Date.parse(claim.claimEndsAt) : Number.NaN;
  if (Number.isFinite(closes) && now >= closes) return "expired";
  if (!Number.isFinite(opens) || now < opens) return "upcoming";
  return "claimable";
}

/**
 * A reward amount with grouped thousands and at most `fractionDigits`
 * decimals, trailing zeros dropped. Null when the decimals are not known, so
 * an amount is never shown at a guessed scale.
 */
export function formatRewardAmount(amount: string, decimals: number | null | undefined, fractionDigits = 2): string | null {
  if (!/^\d+$/.test(amount) || decimals === null || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).slice(0, Math.max(0, fractionDigits)).replace(/0+$/, "") : "";
  const grouped = whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // A positive amount below the shown precision reads as "< 0.01", never as 0.
  if (grouped === "0" && !fraction && /[1-9]/.test(amount) && fractionDigits > 0) return `< 0.${"0".repeat(fractionDigits - 1)}1`;
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** Parts per million as a percentage with two decimals ("12.34%"), or null. */
export function formatSharePpm(ppm: string): string | null {
  if (!/^\d+$/.test(ppm)) return null;
  const value = BigInt(ppm);
  if (value > BigInt(1_000_000)) return null;
  // Hundredths of a percent, rounded down.
  const hundredths = Number(value / BigInt(100));
  if (hundredths === 0 && value > BigInt(0)) return "< 0.01%";
  return `${(hundredths / 100).toFixed(2)}%`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Mon, Dec 1, 00:00 UTC". Epochs and claim windows are set in UTC. */
export function formatRewardTime(iso: string | null | undefined): string | null {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(time) ? `${DATE_FORMAT.format(time)} UTC` : null;
}

/** "Dec 1". */
export function formatRewardDay(iso: string | null | undefined): string | null {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(time) ? DAY_FORMAT.format(time) : null;
}

/**
 * A week's days, "Nov 23 to Nov 29". The end is exclusive (the next week's
 * first moment), so the last day shown is the one before it.
 */
export function formatRewardRange(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  const start = startIso ? Date.parse(startIso) : Number.NaN;
  const end = endIso ? Date.parse(endIso) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return `${DAY_FORMAT.format(start)} to ${DAY_FORMAT.format(end - 1)}`;
}

/** Whole hours left until a warming-up streak reaches the minimum hold, at least 1. */
export function warmingHoursLeft(heldHours: number | null, minHoldHours: number): number {
  const held = typeof heldHours === "number" && Number.isFinite(heldHours) ? heldHours : 0;
  return Math.max(1, Math.ceil(minHoldHours - held));
}

/** Most stages one `is_claimed` request reads. The indexer lists up to 12 epochs per program. */
export const MAX_CLAIMED_STAGES = 24;

/** Parses `?stages=1,2,3` into distinct stage ids (1 to 2^53). Null when malformed or too long. */
export function parseStageList(value: string | null): number[] | null {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length > MAX_CLAIMED_STAGES) return null;
  const stages = new Set<number>();
  for (const part of parts) {
    if (!/^[1-9]\d{0,15}$/.test(part)) return null;
    const stage = Number(part);
    if (!Number.isSafeInteger(stage)) return null;
    stages.add(stage);
  }
  return [...stages];
}

/**
 * The path of a CosmWasm smart query for `is_claimed`, below the chain REST
 * root. QoreChain's gateway decodes the query as standard or URL-safe base64;
 * URL-safe with padding needs no escaping in a path.
 */
export function isClaimedQueryPath(contract: string, stageId: number, address: string) {
  const query = JSON.stringify({ is_claimed: { stage_id: stageId, address } });
  const bytes = new TextEncoder().encode(query);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  return `/cosmwasm/wasm/v1/contract/${contract}/smart/${base64}`;
}

/** Narrows the contract's `{ data: { claimed, amount } }` reply. Null when it is not that shape. */
export function parseIsClaimed(body: unknown): boolean | null {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  const claimed = data && typeof data === "object" ? (data as { claimed?: unknown }).claimed : undefined;
  return typeof claimed === "boolean" ? claimed : null;
}

/**
 * The claim action for `useNativeTransaction().run`, identical to
 * `rewardsClaimAction` in lib/qwakk-native-rewards.ts (a test pins them
 * together). Built here so the page bundle does not take in that module's
 * protobuf encoders; the server validates and encodes the claim.
 */
export function claimActionFor(claim: Pick<QwakkRewardClaim, "stageId" | "amount" | "proof">): RewardsClaimAction {
  return { kind: "rewards_claim", stageId: String(claim.stageId), amount: claim.amount, proof: [...claim.proof] };
}

/**
 * A hero amount: whole units only from 1,000 up (the cents add noise at that
 * size), two decimals below. Rounded down, so it never shows more than is paid.
 */
export function formatRewardHero(amount: string, decimals: number | null | undefined): string | null {
  if (!/^\d+$/.test(amount) || decimals === null || decimals === undefined || !Number.isInteger(decimals) || decimals < 0) return null;
  const whole = decimals ? amount.padStart(decimals + 1, "0").slice(0, -decimals) : amount;
  return formatRewardAmount(amount, decimals, BigInt(whole) >= BigInt(1000) ? 0 : 2);
}

/** Time left until `iso`, coarse: "4d 3h", "3h 12m", "12m". Null once it has passed or when unknown. */
export function formatTimeLeft(iso: string | null | undefined, now: number): string | null {
  const end = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(end) || !now || end <= now) return null;
  const minutes = Math.max(1, Math.floor((end - now) / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/**
 * The one claim to offer now: of the open ones, the window that closes first.
 * `open` counts every claim that can be sent right now.
 */
export function nextRewardClaim<T extends Pick<QwakkRewardClaim, "stageId" | "status" | "claimStartsAt" | "claimEndsAt">>(claims: readonly T[], claimed: (claim: T) => boolean | undefined, now: number): { claim: T | null; open: number } {
  if (!now) return { claim: null, open: 0 };
  const open = claims.filter((claim) => rewardClaimState(claim, claimed(claim), now) === "claimable");
  const closesAt = (claim: T) => (claim.claimEndsAt ? Date.parse(claim.claimEndsAt) : Number.POSITIVE_INFINITY);
  open.sort((a, b) => closesAt(a) - closesAt(b) || a.stageId - b.stageId);
  return { claim: open[0] ?? null, open: open.length };
}
