/**
 * Pure parsing of QoreChain x/amm events from CometBFT block results.
 *
 * The public qorechain-core source (x/amm/types/events.go) lists the event
 * types and attribute keys, but the keeper that emits them is closed source,
 * so which keys each event carries is not verified. Every parser here reads
 * several plausible keys and returns null for fields it cannot prove, rather
 * than guessing. LP balances are never derived from these events: they come
 * from the AMM LP balance query (see the snapshot job in server.ts).
 */

export type EventAttribute = { key?: string; value?: string };
export type ChainEvent = { type?: string; attributes?: EventAttribute[] };
export type EventValues = Record<string, string>;

export const LIQUIDITY_EVENT_TYPES = {
  amm_pool_created: "pool_created",
  amm_liquidity_added: "liquidity_added",
  amm_liquidity_removed: "liquidity_removed",
} as const;

export type LiquidityEventType = (typeof LIQUIDITY_EVENT_TYPES)[keyof typeof LIQUIDITY_EVENT_TYPES];

const ADDRESS_PATTERN = /^qor1[0-9a-z]{20,}$/;
const DIGITS = /^\d+$/;
const COIN_PATTERN = /^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]{1,127})$/;

export function isQorAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function eventValues(event: ChainEvent): EventValues {
  // CometBFT 0.38 returns event attributes as plain strings. A repeated key keeps its first value.
  const values: EventValues = {};
  for (const attribute of event.attributes ?? []) {
    const key = attribute.key ?? "";
    if (key && !(key in values)) values[key] = attribute.value ?? "";
  }
  return values;
}

/** Parses a Cosmos coin list such as "1000000uqor,250utest". Unparseable entries are dropped. */
export function parseCoins(value: string | undefined) {
  if (!value) return [];
  return value.split(",").flatMap((part) => {
    const match = COIN_PATTERN.exec(part.trim());
    return match ? [{ amount: match[1], denom: match[2] }] : [];
  });
}

/**
 * The account that signed the transaction, read from the standard SDK events
 * of the same transaction. Used only when an AMM event has no sender of its own.
 */
export function transactionSender(events: ChainEvent[]) {
  for (const event of events) {
    if (event.type !== "message") continue;
    const sender = eventValues(event).sender?.toLowerCase();
    if (isQorAddress(sender)) return sender;
  }
  for (const event of events) {
    if (event.type !== "tx") continue;
    const values = eventValues(event);
    const payer = values.fee_payer?.toLowerCase();
    if (isQorAddress(payer)) return payer;
    const sequenceOwner = values.acc_seq?.split("/")[0]?.toLowerCase();
    if (isQorAddress(sequenceOwner)) return sequenceOwner;
  }
  return null;
}

function eventSender(values: EventValues, fallback: string | null) {
  for (const key of ["sender", "creator", "provider", "owner"]) {
    const candidate = values[key]?.toLowerCase();
    if (isQorAddress(candidate)) return candidate;
  }
  return fallback;
}

export type ParsedSwap = {
  poolId: string;
  sender: string | null;
  denomIn: string;
  amountIn: string;
  denomOut: string;
  amountOut: string;
};

/** Reads an amm_swap event. Returns null unless pool, both amounts and both denoms are present and non-zero. */
export function parseSwapEvent(values: EventValues, fallbackSender: string | null = null): ParsedSwap | null {
  const poolId = values.pool_id ?? "";
  let amountIn = values.amount_in ?? "";
  let denomIn = values.denom_in ?? "";
  let amountOut = values.amount_out ?? "";
  let denomOut = values.denom_out ?? "";
  // Some modules emit "1000uqor" in amount_in or tokens_in instead of a separate denom.
  if (!denomIn) {
    const [coin] = parseCoins(amountIn || values.tokens_in);
    if (coin) ({ amount: amountIn, denom: denomIn } = coin);
  }
  if (!denomOut) {
    const [coin] = parseCoins(amountOut || values.tokens_out);
    if (coin) ({ amount: amountOut, denom: denomOut } = coin);
  }
  if (!DIGITS.test(poolId) || !DIGITS.test(amountIn) || !DIGITS.test(amountOut) || !denomIn || !denomOut) return null;
  if (BigInt(amountIn) === BigInt(0) || BigInt(amountOut) === BigInt(0)) return null;
  return { poolId, sender: eventSender(values, fallbackSender), denomIn, amountIn, denomOut, amountOut };
}

export type ParsedLiquidityEvent = {
  eventType: LiquidityEventType;
  poolId: string | null;
  sender: string | null;
  /** Normalized coin list moved by the event, for example "1000000uqor,2000000utest". Null when not present. */
  coins: string | null;
  /** The uqor side of the coins, in uqor. Null when the event does not carry it. */
  qorAmount: string | null;
  /** LP shares minted (create, add) or burned (remove). Null when the event does not carry it. */
  lpAmount: string | null;
};

/**
 * Reads amm_pool_created, amm_liquidity_added and amm_liquidity_removed.
 * Returns null for any other event type. Missing fields stay null.
 */
export function parseLiquidityEvent(type: string | undefined, values: EventValues, fallbackSender: string | null = null): ParsedLiquidityEvent | null {
  const eventType = LIQUIDITY_EVENT_TYPES[(type ?? "") as keyof typeof LIQUIDITY_EVENT_TYPES];
  if (!eventType) return null;
  const removing = eventType === "liquidity_removed";

  const coins = new Map<string, string>();
  const add = (denom: string, amount: string) => {
    if (denom && DIGITS.test(amount) && !coins.has(denom)) coins.set(denom, amount);
  };
  for (const coin of parseCoins(removing ? values.tokens_out : values.tokens_in)) add(coin.denom, coin.amount);
  for (const coin of parseCoins(removing ? values.amount_out : values.amount_in)) add(coin.denom, coin.amount);
  // token_a / token_b may be coins ("1000uqor") or bare denoms paired with amount_a / amount_b.
  for (const side of ["a", "b"] as const) {
    const token = values[`token_${side}`] ?? "";
    const [coin] = parseCoins(token);
    if (coin) add(coin.denom, coin.amount);
    else add(token, values[`amount_${side}`] ?? "");
  }
  if (removing && values.denom_out) add(values.denom_out, values.amount_out ?? "");
  if (!removing && values.denom_in) add(values.denom_in, values.amount_in ?? "");

  const lpAmount = removing ? values.lp_burned : values.lp_minted;
  const poolId = values.pool_id ?? "";
  return {
    eventType,
    poolId: DIGITS.test(poolId) ? poolId : null,
    sender: eventSender(values, fallbackSender),
    coins: coins.size ? [...coins].map(([denom, amount]) => `${amount}${denom}`).join(",") : null,
    qorAmount: coins.get("uqor") ?? null,
    lpAmount: DIGITS.test(lpAmount ?? "") ? lpAmount as string : null,
  };
}

/** Transfers one sender made in a transaction outside its AMM messages: recipient, then denom, then amount. */
export type SenderTransfers = Record<string, Record<string, string>>;

/**
 * Every bank transfer of a transaction that a message other than an AMM
 * message made, grouped by sender, read from the standard `transfer` events.
 * Transfers without `msg_index` (the network fee, taken before any message
 * runs) and transfers of AMM messages (swap deposits and payouts) are left
 * out, so what remains is what each sender chose to send, such as Qwakk's
 * interface fee MsgSend. Stored per swap, it lets the points rules accept any
 * set of treasury addresses and any minimum fee without reading the chain again.
 */
export function senderTransfers(events: ChainEvent[]) {
  const ammMessages = new Set<string>();
  for (const event of events) {
    const index = event.type?.startsWith("amm_") ? eventValues(event).msg_index : undefined;
    if (index !== undefined) ammMessages.add(index);
  }
  const bySender = new Map<string, SenderTransfers>();
  for (const event of events) {
    if (event.type !== "transfer") continue;
    const values = eventValues(event);
    const sender = values.sender?.toLowerCase();
    const recipient = values.recipient?.toLowerCase();
    if (values.msg_index === undefined || ammMessages.has(values.msg_index) || !isQorAddress(sender) || !isQorAddress(recipient)) continue;
    const transfers = bySender.get(sender) ?? {};
    const coins = transfers[recipient] ?? {};
    for (const coin of parseCoins(values.amount)) coins[coin.denom] = (BigInt(coins[coin.denom] ?? "0") + BigInt(coin.amount)).toString();
    transfers[recipient] = coins;
    bySender.set(sender, transfers);
  }
  return bySender;
}

/** The transfers stored with one swap: those of its sender, or none. */
export function transfersOf(bySender: Map<string, SenderTransfers>, sender: string | null): SenderTransfers {
  return (sender && bySender.get(sender.toLowerCase())) || {};
}
