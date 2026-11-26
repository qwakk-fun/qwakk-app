/**
 * The token send action's shape, kept free of imports so browser code can use
 * it without pulling the SDK into the page bundle (like lib/qwakk-rewards-view.ts
 * does for claims). The server builds and checks it in lib/qwakk-native-send.ts.
 */

export const SEND_KIND = "send";

/**
 * What the UI passes to `useNativeTransaction().run(...)`. `amount` is base
 * units as a base-10 integer string (uqor for QOR, 6 decimals). `denom` is the
 * exact denom from the wallet's balance: `uqor` or `erc20:0x…`. The sender is
 * never part of the action: the server uses the connected address.
 */
export type SendAction = { kind: typeof SEND_KIND; toAddress: string; denom: string; amount: string };

/** Native QOR or a converted ERC-20 bank denom. LP shares are not bank coins and never match. */
const SENDABLE_DENOM = /^(?:uqor|erc20:0x[0-9a-fA-F]{40})$/;

/** True for the denoms a send may move. The server checks again. */
export function isSendableDenom(denom: string) {
  return SENDABLE_DENOM.test(denom);
}

/** The action for one transfer. */
export function sendAction(input: { toAddress: string; denom: string; amount: string }): SendAction {
  return { kind: SEND_KIND, toAddress: input.toAddress.trim(), denom: input.denom, amount: input.amount };
}
