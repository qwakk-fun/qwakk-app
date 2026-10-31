/**
 * The official QoreChain testnet faucet, from
 * https://docs.qorechain.io/dashboard/faucet (checked 2026-10-31): the page
 * lives at dashboard.qorechain.io/faucet, needs a Dashboard sign-in, pays on
 * `qorechain-diana` only, and allows one claim every 24 hours per account and
 * per address. A claim pays 100 QOR, plus 1000 fUSD, 0.5 fETH and 0.02 fBTC in
 * a separate transaction ("at the time of writing, 27 October 2026"). There is
 * no mainnet faucet, so nothing here may render on mainnet.
 */

export const QORECHAIN_FAUCET_URL = "https://dashboard.qorechain.io/faucet";

/** One claim, in display units. */
export const FAUCET_DAILY_AMOUNTS = [
  { symbol: "QOR", amount: "100" },
  { symbol: "fUSD", amount: "1,000" },
  { symbol: "fETH", amount: "0.5" },
  { symbol: "fBTC", amount: "0.02" },
] as const;

/** The QOR part of one claim, in uqor. */
export const FAUCET_DAILY_UQOR = BigInt(100_000_000);

/** "100 QOR, 1,000 fUSD, 0.5 fETH and 0.02 fBTC". */
export function faucetAmountsText() {
  const parts = FAUCET_DAILY_AMOUNTS.map(({ symbol, amount }) => `${amount} ${symbol}`);
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
