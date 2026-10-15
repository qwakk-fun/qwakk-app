import { BRAND } from "./brand";

/**
 * Every line of the testnet points pages. The product name comes only from
 * BRAND. The rule numbers below match the defaults in
 * `indexer/points-config.ts` and the 5 minute scoring interval in
 * `indexer/server.ts`. That config is read from QWAKK_POINTS_* environment
 * variables in the indexer and is not sent to the browser, so if the owner
 * retunes a value, these lines must change with it. The pool bonus trader
 * count is the one number the API sends (`requiredTraders`); it is rendered
 * from data where it appears per pool.
 */

const brand = BRAND.name;

export const POINTS_NAV_LABEL = "Points";

export const POINTS_META = {
  title: `Points | ${brand}`,
  description: `See who has been swapping, adding liquidity and opening pools on ${brand}. Points have no monetary value.`,
  walletTitle: (short: string) => `Points for ${short} | ${brand}`,
  walletDescription: `Points, rank and daily history for this wallet on ${brand}. Points have no monetary value.`,
} as const;

export const POINTS_HERO = {
  kicker: "Leaderboard",
  title: "Points",
  subline: `Who has been swapping, pooling and showing up on ${brand}. Bragging rights only.`,
  season: (season: string) => `Season ${season} on QoreChain Diana`,
  ranked: (total: string) => `${total} wallets on the board`,
} as const;

export const POINTS_UPDATED = {
  now: "Updated just now",
  one: "Updated 1 min ago",
  many: (minutes: number) => `Updated ${minutes} min ago`,
  hours: "Updated over an hour ago",
  pending: "First scores land within 5 minutes",
} as const;

export const POINTS_DISCLAIMER = `Points have no monetary value, are not a token and cannot be sold, transferred or exchanged. ${brand} may change the rules, correct scores or reset points at any time.`;

export type PointsCategory = "swaps" | "liquidity" | "pools" | "activity";

export const POINTS_CATEGORIES: Array<{ key: PointsCategory; label: string; tooltip: string }> = [
  { key: "swaps", label: "Swaps", tooltip: "1 point per QOR swapped, within the daily limits." },
  { key: "liquidity", label: "Liquidity", tooltip: "0.01 points per QOR for every hour your liquidity stays in." },
  { key: "pools", label: "Pools", tooltip: "500 points for each pool you created that 5 other wallets trade in." },
  { key: "activity", label: "Activity", tooltip: "50 points for each day with a counted move." },
];

export const POINTS_RULES = {
  title: "How points work",
  intro: "Four ways to score. Everything is counted from QoreChain data and recalculated every 5 minutes.",
  cards: [
    {
      key: "swaps",
      title: "Swaps",
      lines: [
        "1 point for every QOR you swap.",
        "The QOR side of a swap must be at least 1 QOR.",
        "Each day: full points on your first 1,000 QOR, 20% from 1,000 to 10,000 QOR, nothing above 10,000 QOR.",
        "Swap back in the same pool within 30 minutes and both swaps count at 10%.",
      ],
      example: "Example: you swap 3,000 QOR in one day. The first 1,000 QOR score 1,000 points, the next 2,000 QOR score 400. Total: 1,400 points.",
    },
    {
      key: "liquidity",
      title: "Liquidity",
      lines: [
        "0.01 points per QOR of liquidity, for every hour it stays in a pool.",
        "Positions are checked once an hour. Hold at least 6 hours in a row before anything counts, then every hour of that stretch counts.",
        "Full points on the first 5,000 QOR you hold, 20% from 5,000 to 50,000 QOR, nothing above 50,000 QOR.",
      ],
      example: "Example: 1,000 QOR of liquidity held for 24 hours scores 240 points.",
    },
    {
      key: "pools",
      title: "Pools",
      lines: [
        "500 points for creating a pool, once 5 other wallets have each swapped at least 1 QOR in it.",
        "Up to 3 pool bonuses per wallet each season.",
      ],
    },
    {
      key: "activity",
      title: "Activity",
      lines: [
        "50 points for every day you show up.",
        "A day counts when you make a counted swap, or add liquidity or create a pool with at least 1 QOR.",
      ],
    },
  ] as Array<{ key: PointsCategory; title: string; lines: string[]; example?: string }>,
  fine: [
    "Only pools paired with QOR score for now.",
    "Days run on UTC.",
    `${brand}'s own wallets are not ranked.`,
    "Tied scores go to the wallet that started first.",
    "Every update recalculates the whole season, so totals and ranks can move up or down.",
  ],
} as const;

export const POINTS_COLUMNS = {
  tableLabel: "Points leaderboard",
  rank: "Rank",
  wallet: "Wallet",
  total: "Points",
  totalTooltip: "Total for this season.",
  days: "Active days",
  daysTooltip: "Days (UTC) with at least one counted move.",
} as const;

export const POINTS_YOU = {
  badge: "You",
  pinnedLabel: "Your spot",
  pinnedRank: (rank: string, total: string) => `#${rank} of ${total}`,
  pinnedUnranked: "Not on the board yet",
  pinnedLink: "See your breakdown",
} as const;

export const POINTS_PAGINATION = {
  prev: "Previous",
  next: "Next",
  status: (page: string, pages: string) => `Page ${page} of ${pages}`,
  aria: "Leaderboard pages",
} as const;

export const POINTS_LOOKUP = {
  label: "Look up a wallet",
  placeholder: "Paste a qor1 address",
  button: "Check",
  invalid: "That is not a QoreChain address. It should start with qor1.",
} as const;

export const POINTS_STATES = {
  loading: "Counting points…",
  emptyClosed: {
    title: "The pond is quiet, for now",
    body: `Trading on ${brand} opens soon. The first counted swap puts a wallet on the board.`,
    button: "Read the rules",
  },
  emptyOpen: {
    title: "No one on the board yet",
    body: "Top spot is up for grabs. Swaps of 1 QOR or more in QOR pools count.",
    button: "Start trading",
  },
  unavailable: {
    title: "Points are temporarily unavailable",
    body: "The points service could not be reached. Your on-chain activity is not affected.",
    button: "Try again",
  },
} as const;

export const POINTS_CONNECT = {
  title: "Where do you rank?",
  body: "See your points, rank and breakdown here. Only your public address is used.",
  button: "Connect wallet",
} as const;

export const POINTS_WALLET = {
  kicker: "Wallet points",
  yours: "This is your wallet",
  copy: "Copy address",
  copied: "Address copied",
  back: "Back to leaderboard",
  rankLabel: "Rank",
  rankValue: (rank: string, total: string) => `#${rank} of ${total}`,
  totalLabel: "Points",
  unrankedTitle: "Not ranked yet",
  unrankedBody: "No counted activity this season so far.",
  breakdownTitle: "Where the points come from",
  loading: "Counting this wallet's points…",
  invalid: {
    title: "That is not a QoreChain address",
    body: "Check it and try again. QoreChain addresses start with qor1.",
  },
  unavailable: {
    title: "Points are temporarily unavailable",
    body: "The points service could not be reached. Your on-chain activity is not affected.",
    button: "Try again",
  },
} as const;

export const POINTS_STATS = {
  swapVolume: { label: "Counted swap volume", value: (qor: string) => `${qor} QOR`, tooltip: "Swaps of 1 QOR or more in QOR pools." },
  roundTrip: { label: "Swapped back fast", value: (qor: string) => `${qor} QOR`, tooltip: "Part of your volume swapped back in the same pool within 30 minutes. It counts at 10%." },
  liquidityHours: { label: "Liquidity held", value: (qor: string) => `${qor} QOR-hours`, tooltip: "QOR value of your liquidity times the hours it was held. 1,000 QOR for 2 hours is 2,000 QOR-hours." },
  poolsCreated: { label: "Pools created", value: (n: string) => n, tooltip: "" },
  poolsUnlocked: { label: "Pool bonuses unlocked", value: (n: string) => `${n} of 3`, tooltip: "Each wallet can unlock up to 3 pool bonuses per season." },
  activeDays: { label: "Active days", value: (n: string) => n, tooltip: "Days (UTC) with at least one counted move." },
} as const;

export const POINTS_POOLS = {
  title: "Your pools",
  empty: "No pools created this season.",
  status: {
    locked: { label: (traders: string, required: string) => `Locked: ${traders} of ${required} traders`, tooltip: (required: string) => `Unlocks when ${required} other wallets have each swapped at least 1 QOR here.` },
    unlocked: { label: (points: string) => `Unlocked: +${points}`, tooltip: (required: string) => `${required} other wallets traded here. Bonus added to your total.` },
    over_limit: { label: () => "Limit reached", tooltip: () => "This wallet already has 3 pool bonuses this season." },
    not_scored: { label: () => "Not scored", tooltip: () => "Only pools paired with QOR score for now." },
  },
} as const;

export const POINTS_DAYS = {
  title: "Daily history",
  note: "Last 90 days, newest first. Days run on UTC.",
  colDay: "Day",
  colVolume: "Swap volume",
  colRoundTrip: "Swapped back",
  colSwapPoints: "Swap points",
  colLiquidityPoints: "Liquidity points",
  colActive: "Active",
  activeYes: "+50",
  activeNo: "No",
  empty: "Nothing scored yet this season.",
} as const;

/** Section heading only; the approved copy names the questions, not the section. */
export const POINTS_FAQ_TITLE = "Questions";

export const POINTS_FAQ: Array<{ question: string; answer: string }> = [
  { question: "Are points worth anything?", answer: `No. Points have no monetary value, are not a token and come with no promise of any future token, payment or benefit. They show who has been active on ${brand}. That is all.` },
  { question: "How often do points update?", answer: "Every 5 minutes. Each update recalculates the whole season from QoreChain data, so your total and rank can move up or down." },
  { question: "Why did my swap not count?", answer: "Swaps under 1 QOR, swaps in pools without QOR, and volume above 10,000 QOR in one day score nothing. Swapping back in the same pool within 30 minutes counts at 10%." },
  { question: "Why are my liquidity points not showing?", answer: "Liquidity counts only after 6 hours held in a row. Positions are checked once an hour, so new hours show up after the next check." },
  { question: "How do I unlock a pool bonus?", answer: "Create a pool paired with QOR. Once 5 other wallets have each swapped at least 1 QOR in it, you get 500 points. Up to 3 per wallet each season." },
  { question: "Can the rules change?", answer: `Yes. ${brand} may change the rules, correct scores or reset points at any time, and a change can apply to past activity too.` },
];
