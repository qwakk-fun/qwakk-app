/**
 * Portfolio page math: what each held token is worth in QOR, the wallet's
 * estimated total, how it splits across tokens, and a pool share. Integer
 * string math only, truncated toward zero, so an estimate never reads larger
 * than it is. Kept free of React so tests can call it.
 */

const UNSIGNED = /^\d+$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const QOR_SCALE = BigInt(1_000_000);

/**
 * QOR value (uqor) of `amount` base units of a token with `decimals`, at
 * `qorPerToken` QOR per whole token (an exact decimal string). Null when any
 * input is unusable.
 */
export function tokenValueUqor(amount: string, decimals: number | null, qorPerToken: string | null | undefined): bigint | null {
  if (!UNSIGNED.test(amount) || decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (typeof qorPerToken !== "string" || !DECIMAL.test(qorPerToken)) return null;
  const [whole, fraction = ""] = qorPerToken.split(".");
  const price = BigInt(`${whole}${fraction}`);
  const divisor = BigInt(10) ** BigInt(decimals + fraction.length);
  return (BigInt(amount) * price * QOR_SCALE) / divisor;
}

export type Holding = { denom: string; uqor: bigint | null };

/** The estimated total in uqor, and how many held tokens had no usable price. */
export function portfolioTotal(holdings: readonly Holding[]) {
  let total = BigInt(0);
  let unpriced = 0;
  for (const holding of holdings) {
    if (holding.uqor === null) unpriced += 1;
    else total += holding.uqor;
  }
  return { totalUqor: total, unpriced };
}

export type AllocationSlice = { key: string; denoms: string[]; uqor: bigint; /** Share of the priced total in basis points (10000 = 100%). */ bps: number };

/**
 * How the priced total splits across tokens, largest first. Tokens past
 * `maxSlices - 1`, and any below 1%, are folded into one "other" slice so the
 * bar stays readable. Empty when fewer than two tokens carry value.
 */
export function allocation(holdings: readonly Holding[], maxSlices = 4): AllocationSlice[] {
  const priced = holdings.filter((holding): holding is { denom: string; uqor: bigint } => holding.uqor !== null && holding.uqor > BigInt(0));
  if (priced.length < 2) return [];
  const total = priced.reduce((sum, holding) => sum + holding.uqor, BigInt(0));
  const sorted = [...priced].sort((a, b) => (b.uqor > a.uqor ? 1 : b.uqor < a.uqor ? -1 : a.denom.localeCompare(b.denom)));
  const share = (value: bigint) => Number((value * BigInt(10_000)) / total);
  const slices: AllocationSlice[] = [];
  const rest: { denom: string; uqor: bigint }[] = [];
  for (const holding of sorted) {
    if (slices.length < maxSlices - 1 && share(holding.uqor) >= 100) slices.push({ key: holding.denom, denoms: [holding.denom], uqor: holding.uqor, bps: share(holding.uqor) });
    else rest.push(holding);
  }
  if (rest.length === 1 && slices.length < maxSlices) {
    slices.push({ key: rest[0].denom, denoms: [rest[0].denom], uqor: rest[0].uqor, bps: share(rest[0].uqor) });
  } else if (rest.length) {
    const uqor = rest.reduce((sum, holding) => sum + holding.uqor, BigInt(0));
    slices.push({ key: "other", denoms: rest.map((holding) => holding.denom), uqor, bps: share(uqor) });
  }
  return slices;
}

/** A share in basis points as a short percent: "42%", "4.2%", "0.42%", "< 0.01%". */
export function formatBps(bps: number) {
  if (!Number.isFinite(bps) || bps <= 0) return "0%";
  if (bps >= 1_000) return `${Math.floor(bps / 100)}%`;
  if (bps >= 100) return `${(Math.floor(bps / 10) / 10).toString()}%`;
  return `${(bps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/**
 * The wallet's share of a pool from its LP balance and the pool's LP supply,
 * as text ("12.5%", "0.034%", "< 0.001%"). Null when unknown.
 */
export function formatPoolShare(lpBalance: string, lpSupply: string): string | null {
  if (!UNSIGNED.test(lpBalance) || !UNSIGNED.test(lpSupply)) return null;
  const balance = BigInt(lpBalance);
  const supply = BigInt(lpSupply);
  if (supply <= BigInt(0) || balance <= BigInt(0)) return null;
  if (balance >= supply) return "100%";
  // Parts per ten million: three decimals of a percent.
  const ppt = (balance * BigInt(10_000_000)) / supply;
  if (ppt === BigInt(0)) return "< 0.001%";
  const whole = ppt / BigInt(100_000);
  const digits = whole >= BigInt(10) ? 1 : whole >= BigInt(1) ? 2 : 3;
  const fraction = (ppt % BigInt(100_000)).toString().padStart(5, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

/** QOR first, then the most valuable, then by symbol. */
export function compareHoldings(a: { denom: string; uqor: bigint | null; symbol: string }, b: { denom: string; uqor: bigint | null; symbol: string }) {
  if (a.denom === "uqor" || b.denom === "uqor") return a.denom === "uqor" ? (b.denom === "uqor" ? 0 : -1) : 1;
  const av = a.uqor ?? BigInt(-1);
  const bv = b.uqor ?? BigInt(-1);
  if (av !== bv) return bv > av ? 1 : -1;
  return a.symbol.localeCompare(b.symbol);
}
