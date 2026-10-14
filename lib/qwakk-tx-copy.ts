/**
 * Controlled copy for every way a native transaction can stop. Raw chain or
 * wallet text never reaches the screen; it is mapped to one of these lines.
 */

export const SIMULATION_FAILURE_COPY = {
  insufficient_funds: "This wallet does not have enough balance for the amounts and the network fee.",
  pool_not_found: "This pool is not available on QoreChain Diana.",
  pool_exists: "A pool for this token pair already exists. Add liquidity to it instead.",
  pool_paused: "This pool is paused right now.",
  price_moved: "The price moved beyond your price protection. Review the new quote.",
  insufficient_liquidity: "The pool does not hold enough liquidity for this amount.",
  below_min_liquidity: "The deposit is below the pool's minimum liquidity.",
  pool_limit: "This wallet has reached the maximum number of pools it can create.",
  rejected: "QoreChain Diana would not accept this transaction.",
} as const;

export type SimulationFailureKey = keyof typeof SIMULATION_FAILURE_COPY;

export const QOREX_MISSING_COPY = "Install QoreX to sign QoreChain transactions.";
export const QOREX_OUTDATED_COPY = "This QoreX is too old to trade here. Update it to version 0.3.5 or newer, then try again.";
export const QOREX_NETWORK_COPY = "QoreX is on another network. Open QoreX, tap the version number at the bottom 7 times to turn on Developer mode, choose Switch to testnet (diana), then try again.";

export type WalletFailureKind = "declined" | "locked" | "network" | "outdated" | "account" | "chain" | "onchain" | "other";
export type WalletFailure = { kind: WalletFailureKind; copy: string; code?: number; codespace?: string };

/**
 * Classifies a QoreX error (QoreX 0.3.5 `enable`, `getKey` and
 * `signAndBroadcast`). Only fixed copy and numeric chain codes come out; the
 * wallet's own text is never shown.
 */
export function walletFailure(error: unknown): WalletFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.toLowerCase();

  // CheckTx refusal: "Transaction rejected by the network (<codespace> <code>): <log>".
  const refused = /rejected by the network \(([a-z0-9_]+) (\d+)\)/i.exec(raw);
  if (refused) {
    const codespace = refused[1] === "unknown" ? "" : refused[1].toLowerCase();
    const code = Number(refused[2]);
    return { kind: "chain", copy: chainFailureCopy(codespace, code), code, codespace };
  }
  // Included in a block but failed: "Transaction failed on-chain (code <n>)." QoreX
  // keeps the hash in its error data, which does not reach the page.
  if (message.includes("failed on-chain")) {
    const failed = /failed on-chain \(code (\d+)\)/i.exec(raw);
    const code = failed ? Number(failed[1]) : undefined;
    return {
      kind: "onchain",
      ...(code === undefined ? {} : { code }),
      copy: code === 11
        ? "The transaction ran out of network gas in its block. Only the network fee was spent. Try again."
        : "QoreChain Diana included the transaction but it failed. Only the network fee was spent. Check your QoreX activity for the details.",
    };
  }
  if (message.includes("rejected")) {
    return { kind: "declined", copy: "The request was declined in QoreX." };
  }
  if (/(?<!un)locked/.test(message)) return { kind: "locked", copy: "QoreX is locked. Unlock it and try again." };
  if (message.includes("active network") || message.includes("unsupported chain")) return { kind: "network", copy: QOREX_NETWORK_COPY };
  if (message.includes("requires an updated wallet")) return { kind: "outdated", copy: "QoreChain Diana needs a newer QoreX. Update it and try again." };
  if (message.includes("refusing to sign") || message.includes("unknown signer")) {
    return { kind: "account", copy: "QoreX is using a different account than the one connected here. Reconnect your wallet and try again." };
  }
  if (message.includes("pqc key registration failed")) {
    return { kind: "other", copy: "QoreX could not set up the quantum-safe key for this wallet. Try again shortly." };
  }
  if (message.includes("too many transactions")) {
    return { kind: "other", copy: "Too many transactions from this wallet in a short time. Wait a minute and try again." };
  }
  return { kind: "other", copy: "QoreX did not complete the transaction." };
}

/** Maps a QoreX error to controlled copy. */
export function walletFailureCopy(error: unknown) {
  return walletFailure(error).copy;
}

/** Maps a chain result code to controlled copy, before or after inclusion in a block. */
export function chainFailureCopy(codespace: string, code: number) {
  // QoreX adds the post-quantum layer itself, so a pqc refusal means Diana rejected that layer.
  if (codespace === "pqc") return `QoreChain Diana did not accept QoreX's quantum-safe signature (pqc code ${code}). Update QoreX and try again.`;
  if (codespace === "amm" && code === 4) return SIMULATION_FAILURE_COPY.price_moved;
  if (codespace === "amm" && code === 1) return SIMULATION_FAILURE_COPY.pool_not_found;
  if (codespace === "amm" && code === 5) return SIMULATION_FAILURE_COPY.pool_paused;
  if (codespace === "sdk" && code === 5) return SIMULATION_FAILURE_COPY.insufficient_funds;
  if (codespace === "sdk" && code === 13) return "The network fee was too low. Try again.";
  if (codespace === "sdk" && code === 32) return "Another transaction from this wallet is pending. Try again in a moment.";
  return "QoreChain Diana did not accept the transaction.";
}
