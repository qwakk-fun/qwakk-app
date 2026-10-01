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

/** Maps a QoreX error to controlled copy. */
export function walletFailureCopy(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("rejected")) return "The request was declined in QoreX.";
  if (message.includes("locked")) return "QoreX is locked. Unlock it and try again.";
  if (message.includes("active network") || message.includes("unsupported chain")) return "QoreX is on a different network. Switch it to QoreChain Diana and try again.";
  if (message.includes("not found in wallet") || message.includes("unknown signer")) return "QoreX could not match this account to its signer.";
  if (message.includes("quantum-safe")) return "QoreX requires the post-quantum layer for this transaction.";
  return "QoreX did not return a signature.";
}

/** Maps a chain result code to controlled copy, before or after inclusion in a block. */
export function chainFailureCopy(codespace: string, code: number) {
  if (codespace === "pqc") return "QoreChain Diana requires a post-quantum signature for this transaction.";
  if (codespace === "amm" && code === 4) return SIMULATION_FAILURE_COPY.price_moved;
  if (codespace === "amm" && code === 1) return SIMULATION_FAILURE_COPY.pool_not_found;
  if (codespace === "amm" && code === 5) return SIMULATION_FAILURE_COPY.pool_paused;
  if (codespace === "sdk" && code === 5) return SIMULATION_FAILURE_COPY.insufficient_funds;
  if (codespace === "sdk" && code === 13) return "The network fee was too low. Try again.";
  if (codespace === "sdk" && code === 32) return "Another transaction from this wallet is pending. Try again in a moment.";
  return "QoreChain Diana did not accept the transaction.";
}
