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
  impact_too_high: "This swap would move the pool price more than QoreChain Diana allows in one trade. Try a smaller amount.",
  network_fee: "This wallet needs a little more QOR to cover the network fee on top of the amounts.",
  pool_creation_fee: "Creating a pool needs the pool creation fee on top of both deposits and the network fee. Add QOR and try again.",
  module_disabled: "Trading on QoreChain Diana's native AMM is switched off right now.",
  rejected: "QoreChain Diana would not accept this transaction.",
} as const;

/** Why a swap quote could not be produced. */
export const QUOTE_FAILURE_COPY = {
  pool_not_found: "This pool is not available on QoreChain Diana.",
  pair: "This pool does not trade that token.",
  impact_too_high: "This swap is too large for the pool. Try a smaller amount.",
  insufficient_liquidity: "The pool does not hold enough liquidity for this amount.",
  pool_paused: "This pool is paused right now.",
  invalid: "QoreChain Diana could not quote this swap. Check the amount.",
  unavailable: "The QoreChain Diana quote service is temporarily unavailable.",
} as const;

/** Why a quote that was produced cannot be signed. */
export const QUOTE_BLOCK_COPY = {
  impact: "This swap would move the pool price by more than QoreChain Diana allows in one trade.",
  paused: "This pool is paused right now, so swaps and liquidity changes are on hold.",
  disabled: "Trading on QoreChain Diana's native AMM is switched off right now.",
  too_small: "This amount is too small to swap. Enter a larger amount.",
} as const;

export type SimulationFailureKey = keyof typeof SIMULATION_FAILURE_COPY;

/**
 * Shown when Qwakk cannot confirm a token's decimals. Amounts for it are never
 * guessed, so entering or sending them stays blocked.
 */
export function assetDecimalsUnknownCopy(symbol: string) {
  return `Qwakk cannot confirm how many decimals ${symbol} uses yet, so amounts for it are on hold.`;
}

export const QOREX_MISSING_COPY = "Install QoreX to sign QoreChain transactions.";
export const QOREX_OUTDATED_COPY = "This QoreX is too old to trade here. Update it to version 0.3.5 or newer, then try again.";
export const QOREX_NETWORK_COPY = "QoreX is on another network. Open QoreX, tap the version number at the bottom 7 times to turn on Developer mode, choose Switch to testnet (diana), then try again.";
/** docs.qorechain.io/qorex/troubleshooting: "Settings → Use testnet (developers) ... Turn it off to return to mainnet." */
export const QOREX_MAINNET_NETWORK_COPY = "QoreX is on the testnet. Open QoreX Settings, turn off Use testnet (developers), then try again.";

/** The network as copy needs it. Matches `PublicQwakkNetwork` in lib/qwakk-network.ts. */
export type CopyNetwork = { id: "testnet" | "mainnet"; label: string };

/** The testnet label the copy constants in this file are written with. */
const TESTNET_LABEL = "QoreChain Diana";

/**
 * Puts the deployment's network name into a controlled line. The constants in
 * this file name the testnet ("QoreChain Diana"); on mainnet that becomes the
 * mainnet label. Only fixed copy goes through here, never wallet or chain text.
 */
export function networkCopy(copy: string, network?: Pick<CopyNetwork, "label"> | null) {
  if (!network || network.label === TESTNET_LABEL) return copy;
  return copy.split(TESTNET_LABEL).join(network.label);
}

/** How to put QoreX on the network this deployment trades on. */
export function qorexNetworkCopy(network?: Pick<CopyNetwork, "id"> | null) {
  return network?.id === "mainnet" ? QOREX_MAINNET_NETWORK_COPY : QOREX_NETWORK_COPY;
}

/**
 * Shown while QoreX is open for a transaction that carries the interface fee.
 * QoreX lists the fee as its own transfer, so this names it in plain words.
 */
export function interfaceFeeTransferCopy(amount: string, brandName: string) {
  return `This transaction includes an interface fee of ${amount}. In QoreX it shows up as a transfer to the ${brandName} treasury.`;
}

/** A quote whose minimum is 0 base units: signing it could return nothing. */
export const QUOTE_ZERO_OUT_COPY = "This amount is too small to get anything back from this pool. Enter a larger amount.";

/** QoreX's active account is not the one Qwakk was showing. */
export const WALLET_ACCOUNT_SWITCHED_COPY = "QoreX switched to another account. Qwakk now shows that account, so check the details and try again.";
/** `/api/features` could not be read, so Qwakk does not know which network to ask QoreX for. */
export const NETWORK_UNKNOWN_COPY = "Qwakk could not confirm the network right now. Try again shortly.";

/**
 * Why `/api/native-tx/prepare` stopped before simulation for an operator
 * reason rather than a chain one.
 */
export const PREPARE_GUARD_COPY = {
  action_disabled: "This action is switched off on Qwakk right now.",
  blocked: "Qwakk has paused this pool or token for now.",
  quote_unavailable: "QoreChain Diana's quote service is not answering, so this swap is on hold. Try again shortly.",
  wrong_network: "Qwakk is connected to the wrong QoreChain network, so wallet actions are paused. Try again later.",
  unreachable: "QoreChain Diana could not be reached. Try again shortly.",
} as const;

export type PrepareGuardKey = keyof typeof PREPARE_GUARD_COPY;

export type WalletFailureKind = "declined" | "locked" | "pending" | "network" | "outdated" | "account" | "chain" | "onchain" | "other";
export type WalletFailure = { kind: WalletFailureKind; copy: string; code?: number; codespace?: string };

/**
 * QoreX is locked. QoreX 0.3.9 `getKey`, `enable` and `signAndBroadcast`
 * check the lock first and reject with "QoreX: wallet is locked" without
 * opening a window, so the user unlocks from the toolbar. Nothing was sent.
 */
export const QOREX_LOCKED_COPY = "QoreX is locked. Open QoreX from your browser toolbar, unlock it, then try again. Nothing was sent.";
/** The user closed or declined the QoreX window ("QoreX: signature rejected", "QoreX: connection rejected"). */
export const QOREX_DECLINED_COPY = "You declined the request in QoreX. Nothing was sent.";
/**
 * QoreX holds one request per site and three in total ("QoreX: a request from
 * this site is already waiting for your answer.", "too many requests are waiting").
 */
export const QOREX_PENDING_COPY = "QoreX already has a request open. Answer or close it in QoreX, then try again.";
/** QoreX 0.3.9: "the wallet or account changed while this request was waiting. Nothing was signed." */
export const QOREX_ACCOUNT_CHANGED_COPY = "QoreX switched wallet or account while the request was open, so nothing was signed. Check the account and try again.";

/**
 * Wallet stops the user caused or can clear in QoreX in a moment. Nothing was
 * sent, so they are shown as a calm notice rather than a failed transaction.
 */
export function isQuietWalletStop(kind: WalletFailureKind) {
  return kind === "declined" || kind === "locked" || kind === "pending" || kind === "account";
}

/**
 * Classifies a QoreX error (QoreX 0.3.5 or newer `enable`, `getKey` and
 * `signAndBroadcast`). Only fixed copy and numeric chain codes come out; the
 * wallet's own text is never shown.
 */
export function walletFailure(error: unknown, network?: CopyNetwork | null): WalletFailure {
  const failure = classifyWalletFailure(error, network ?? null);
  return { ...failure, copy: networkCopy(failure.copy, network) };
}

function classifyWalletFailure(error: unknown, network: CopyNetwork | null): WalletFailure {
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
  if (message.includes("rejected")) return { kind: "declined", copy: QOREX_DECLINED_COPY };
  if (/(?<!un)locked/.test(message)) return { kind: "locked", copy: QOREX_LOCKED_COPY };
  if (message.includes("already waiting for your answer") || message.includes("requests are waiting")) return { kind: "pending", copy: QOREX_PENDING_COPY };
  if (message.includes("changed while this request was waiting")) return { kind: "account", copy: QOREX_ACCOUNT_CHANGED_COPY };
  if (message.includes("active network") || message.includes("unsupported chain")) return { kind: "network", copy: qorexNetworkCopy(network) };
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
export function walletFailureCopy(error: unknown, network?: CopyNetwork | null) {
  return walletFailure(error, network).copy;
}

/** Maps a chain result code to controlled copy, before or after inclusion in a block. */
export function chainFailureCopy(codespace: string, code: number) {
  // QoreX adds the post-quantum layer itself, so a pqc refusal means Diana rejected that layer.
  if (codespace === "pqc") return `QoreChain Diana did not accept QoreX's quantum-safe signature (pqc code ${code}). Update QoreX and try again.`;
  // x/amm codes from qorechain-core x/amm/types/errors.go.
  if (codespace === "amm" && code === 1) return SIMULATION_FAILURE_COPY.pool_not_found;
  if (codespace === "amm" && code === 3) return SIMULATION_FAILURE_COPY.insufficient_liquidity;
  if (codespace === "amm" && code === 4) return SIMULATION_FAILURE_COPY.price_moved;
  if (codespace === "amm" && code === 5) return SIMULATION_FAILURE_COPY.pool_paused;
  if (codespace === "amm" && code === 7) return SIMULATION_FAILURE_COPY.pool_exists;
  if (codespace === "amm" && code === 9) return SIMULATION_FAILURE_COPY.below_min_liquidity;
  if (codespace === "amm" && code === 17) return SIMULATION_FAILURE_COPY.pool_limit;
  if (codespace === "sdk" && code === 5) return SIMULATION_FAILURE_COPY.insufficient_funds;
  if (codespace === "sdk" && code === 13) return "The network fee was too low. Try again.";
  if (codespace === "sdk" && code === 32) return "Another transaction from this wallet is pending. Try again in a moment.";
  return "QoreChain Diana did not accept the transaction.";
}
