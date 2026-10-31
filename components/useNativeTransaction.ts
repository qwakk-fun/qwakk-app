"use client";

import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { qorexSupport, readQoreXSigner, type QoreXMessage } from "../lib/qorex-native";
import { NETWORK_UNKNOWN_COPY, QOREX_MISSING_COPY, QOREX_OUTDATED_COPY, WALLET_ACCOUNT_SWITCHED_COPY, chainFailureCopy, isQuietWalletStop, networkCopy, walletFailure } from "../lib/qwakk-tx-copy";
import type { NativeAction } from "../lib/qwakk-native-actions";
import type { SimulatedOutcome } from "../lib/qwakk-native-tx";
import type { PublicQwakkNetwork } from "../lib/qwakk-network";
import { syncStoredWalletAddress } from "../lib/qwakk-wallet-session";
import { loadFeatures } from "./useFeatures";

export type TxPhase = "idle" | "preparing" | "signing" | "confirming" | "success" | "failed";
export type TxState = {
  phase: TxPhase;
  message: string;
  txhash: string;
  /** Expected network fee in uqor at QoreX's gas price. */
  fee: string;
  /** True when QoreX will first register the wallet's post-quantum key in its own transaction. */
  keySetup: boolean;
  /** The interface fee transfer inside this transaction, in base units. QoreX lists only message types for it. */
  interfaceFee: { denom: string; amount: string } | null;
  /** What QoreChain's keeper reported when it simulated this transaction. */
  simulated: SimulatedOutcome | null;
  /**
   * The action stopped in the wallet before anything was sent (locked,
   * declined, a request already open, account changed). Shown as a calm notice.
   */
  quiet: boolean;
};

type Prepared = {
  chainId: string;
  messages: QoreXMessage[];
  memo: string;
  gasLimit: string;
  fee: { amount: string };
  interfaceFee: { denom: string; amount: string } | null;
  pqcKeyRegistered: boolean | null;
  simulated?: SimulatedOutcome;
};
type Status = { state?: "pending" | "included"; success?: boolean; code?: number; codespace?: string };

const IDLE: TxState = { phase: "idle", message: "", txhash: "", fee: "", keySetup: false, interfaceFee: null, simulated: null, quiet: false };
const CONFIRM_ATTEMPTS = 30;
const SUCCESS_COPY = "Confirmed on QoreChain Diana.";

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/**
 * One wallet action. QoreX is called exactly twice: `getKey` once (silent for
 * a site QoreX already approved; rejects without a window while locked) and
 * `signAndBroadcast` once (the approval window). Nothing here calls `enable`
 * or `listAccounts`, and nothing polls the wallet. Exported for tests.
 */
export async function executeNativeAction(action: NativeAction, setState: Dispatch<SetStateAction<TxState>>) {
  let network: PublicQwakkNetwork | null = null;
  const fail = (message: string, txhash = "", quiet = false) => setState((current) => ({ ...current, phase: "failed", message: networkCopy(message, network), txhash, quiet }));
  const walletStop = (error: unknown) => {
    const failure = walletFailure(error, network);
    return fail(failure.copy, "", isQuietWalletStop(failure.kind));
  };
  const support = qorexSupport(window.qorex?.native);
  if (support.state === "missing") return fail(QOREX_MISSING_COPY);
  if (support.state === "outdated") return fail(QOREX_OUTDATED_COPY);
  const wallet = support.wallet;

  setState({ ...IDLE, phase: "preparing" });
  // The chain id comes from the server's network setting, never a constant.
  network = (await loadFeatures())?.network ?? null;
  if (!network) return fail(NETWORK_UNKNOWN_COPY);
  const chainId = network.chainId;

  let address: string;
  try {
    address = await readQoreXSigner(wallet, chainId);
  } catch (error) {
    return walletStop(error);
  }
  // QoreX emits no account change event, so this is where an account switched
  // inside QoreX is noticed. If its active account is not the one Qwakk was
  // showing, show the new account and stop: amounts and positions on screen
  // belonged to the other account. QoreX itself also refuses to sign messages
  // for any account but its active one (0.3.9 `expectSender`).
  if (syncStoredWalletAddress(address) === "switched") return fail(WALLET_ACCOUNT_SWITCHED_COPY, "", true);

  let prepared: Prepared;
  try {
    const response = await fetch("/api/native-tx/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, action }),
    });
    const data = await response.json() as Prepared & { error?: unknown };
    // The prepare route only ever returns controlled copy in `error`.
    if (!response.ok) return fail(typeof data?.error === "string" && data.error ? data.error : "The transaction could not be prepared.");
    // The server prepared for its configured network; QoreX must sign for the same one.
    if (data.chainId !== chainId) return fail(NETWORK_UNKNOWN_COPY);
    prepared = data;
  } catch {
    return fail("The transaction could not be prepared. Try again shortly.");
  }

  setState((current) => ({
    ...current,
    phase: "signing",
    fee: prepared.fee.amount,
    keySetup: prepared.pqcKeyRegistered === false,
    interfaceFee: prepared.interfaceFee ?? null,
    simulated: prepared.simulated ?? null,
  }));
  let result;
  try {
    result = await wallet.signAndBroadcast({
      chainId: prepared.chainId,
      messages: prepared.messages,
      memo: prepared.memo,
      gasLimit: prepared.gasLimit,
    });
  } catch (error) {
    console.error("QoreX signAndBroadcast failed", error);
    return walletStop(error);
  }

  const txhash = typeof result?.txHash === "string" && /^[0-9A-F]{64}$/i.test(result.txHash) ? result.txHash : "";
  if (!txhash) return fail("QoreX did not return a transaction hash. Check your QoreX activity.");
  // Success only with a real block height. A missing or zero height, or a
  // "pending" shield, means QoreX stopped waiting before the block.
  if (result.code === 0 && Number(result.height) > 0 && result.shield !== "pending") {
    setState((current) => ({ ...current, phase: "success", message: networkCopy(SUCCESS_COPY, network), txhash }));
    window.dispatchEvent(new Event("qwakk:tx-confirmed"));
    return;
  }

  // QoreX stopped waiting before the block, so follow the hash here.
  setState((current) => ({ ...current, phase: "confirming", txhash }));
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
    await wait(2_000);
    try {
      const response = await fetch(`/api/native-tx/status?hash=${txhash}`, { cache: "no-store" });
      const status = await response.json() as Status;
      if (status.state !== "included") continue;
      if (!status.success) return fail(chainFailureCopy(status.codespace ?? "", status.code ?? 0), txhash);
      setState((current) => ({ ...current, phase: "success", message: networkCopy(SUCCESS_COPY, network) }));
      window.dispatchEvent(new Event("qwakk:tx-confirmed"));
      return;
    } catch {
      // A missed poll is retried; the transaction itself is already submitted.
    }
  }
  fail("Still waiting for a block. Check the explorer for the final result.", txhash);
}

/**
 * Runs one native action end to end: the server builds and simulates the
 * messages, QoreX asks the user to approve, then builds, signs (with its
 * post-quantum layer) and broadcasts the transaction itself. The hook follows
 * the returned hash into a block. Keys stay in QoreX. Every failure is
 * reported with controlled copy.
 */
export function useNativeTransaction() {
  const [state, setState] = useState<TxState>(IDLE);
  // Set synchronously, so a double click cannot start a second transaction
  // before React renders the busy state.
  const inFlight = useRef(false);
  const reset = useCallback(() => {
    if (!inFlight.current) setState(IDLE);
  }, []);

  const run = useCallback(async (action: NativeAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await executeNativeAction(action, setState);
    } finally {
      inFlight.current = false;
    }
  }, []);

  return { state, run, reset, busy: state.phase !== "idle" && state.phase !== "success" && state.phase !== "failed" };
}
