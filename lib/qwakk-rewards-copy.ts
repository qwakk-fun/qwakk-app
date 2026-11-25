/**
 * Liquidity rewards copy, in one place so it can be reviewed and polished
 * without touching the components. Short on purpose: one number and one
 * action carry each screen. No em dashes. Amounts arrive formatted.
 */

/** The one honesty line, shown quietly under every rewards surface. */
export const REWARDS_HONESTY = "Testnet QWAKK. No promised value.";

export const REWARDS_POOL = {
  title: "LP rewards",
  weekEnds: (week: number) => `Week ${week} ends in`,
  firstWeek: "First week starts",
  earning: "Earning this week",
  warming: "Warming up",
  warmingValue: (hours: number) => `${hours}h left`,
  warmingNote: (minHold: number) => `Liquidity earns after ${minHold} hours in the pool.`,
  pot: "Shared this week",
  potLabel: "Weekly pot",
  share: "Your share",
  wallets: "Wallets earning",
  idleNote: "Split between this pool's LPs by share and time held.",
  connectNote: "Your share of this week shows up here.",
  excludedNote: (brand: string) => `The ${brand} treasury wallet does not earn rewards.`,
  unavailableNote: "Your share could not be read. Retrying on its own.",
  addButton: "Add liquidity",
  connectButton: "Connect wallet",
  claimButton: (amount: string) => `Claim ${amount}`,
} as const;

export const REWARDS_PORTFOLIO = {
  title: "LP rewards",
  loading: "Reading your rewards…",
  unavailable: "Rewards could not be loaded. Try again in a moment.",
  retry: "Try again",
  ready: "Unclaimed",
  readyNote: (week: number, by: string) => `Week ${week}, open until ${by}`,
  moreReady: (count: number) => `${count} more ${count === 1 ? "week" : "weeks"} after this one`,
  nothingReady: "Each week opens for claims after it ends.",
  claimButton: "Claim",
  thisWeek: "This week so far",
  thisWeekNote: (share: string, left: string) => `${share} of the pool, ends in ${left}`,
  warmingLabel: "Warming up",
  warmingValue: (hours: number) => `${hours}h left`,
  warmingNote: (minHold: number) => `Liquidity earns after ${minHold} hours in the pool.`,
  notEarning: "Not earning this week",
  excluded: "Treasury wallet, not eligible",
  history: "Past weeks",
  week: (week: number) => `Week ${week}`,
  pending: "Opens soon",
  opens: (when: string) => `Opens ${when}`,
  ready_short: "Ready",
  claimed: "Claimed",
  expired: "Expired",
  closed: "Window closed",
  amountUnknown: (amount: string) => `${amount} base units`,
} as const;

/** The claim review, shared by the pool card and the portfolio. */
export const REWARDS_REVIEW = {
  lead: "You claim",
  tail: (week: number) => `from week ${week} to this wallet.`,
  fee: "QoreX shows the network fee in QOR before you approve.",
  cancel: "Cancel",
  confirm: "Confirm in QoreX",
} as const;

/** The badge on pool lists. */
export const REWARDS_TAG = "Rewards";
