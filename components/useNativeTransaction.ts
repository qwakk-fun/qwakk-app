"use client";

import { useCallback, useState } from "react";
import { QORECHAIN_DIANA, qorexSupport, type QoreXMessage } from "../lib/qorex-native";
import { QOREX_MISSING_COPY, QOREX_OUTDATED_COPY, chainFailureCopy, walletFailureCopy } from "../lib/qwakk-tx-copy";
import type { NativeAction } from "../lib/qwakk-native-actions";

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
};

type Prepared = {
  chainId: string;
  messages: QoreXMessage[];
  memo: string;
  gasLimit: string;
  fee: { amount: string };
  interfaceFee: { denom: string; amount: string } | null;
  pqcKeyRegistered: boolean | null;
};
type Status = { state?: "pending" | "included"; success?: boolean; code?: number; codespace?: string };

const IDLE: TxState = { phase: "idle", message: "", txhash: "", fee: "", keySetup: false, interfaceFee: null };
const CONFIRM_ATTEMPTS = 30;
const SUCCESS_COPY = "Confirmed on QoreChain Diana.";

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(async (action: NativeAction) => {
    const fail = (message: string, txhash = "") => setState((current) => ({ ...current, phase: "failed", message, txhash }));
    const support = qorexSupport(window.qorex?.native);
    if (support.state === "missing") return fail(QOREX_MISSING_COPY);
    if (support.state === "outdated") return fail(QOREX_OUTDATED_COPY);
    const wallet = support.wallet;

    setState({ ...IDLE, phase: "preparing" });
    let address: string;
    try {
      await wallet.enable(QORECHAIN_DIANA);
      address = (await wallet.getKey(QORECHAIN_DIANA)).bech32Address;
    } catch (error) {
      return fail(walletFailureCopy(error));
    }

    let prepared: Prepared;
    try {
      const response = await fetch("/api/native-tx/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, action }),
      });
      const data = await response.json() as Prepared & { error?: string };
      if (!response.ok) return fail(data.error ?? "The transaction could not be prepared.");
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
      return fail(walletFailureCopy(error));
    }

    const txhash = typeof result?.txHash === "string" && /^[0-9A-F]{64}$/i.test(result.txHash) ? result.txHash : "";
    if (!txhash) return fail("QoreX did not return a transaction hash. Check your QoreX activity.");
    // Success only with a real block height. A missing or zero height, or a
    // "pending" shield, means QoreX stopped waiting before the block.
    if (result.code === 0 && Number(result.height) > 0 && result.shield !== "pending") {
      setState((current) => ({ ...current, phase: "success", message: SUCCESS_COPY, txhash }));
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
        setState((current) => ({ ...current, phase: "success", message: SUCCESS_COPY }));
        window.dispatchEvent(new Event("qwakk:tx-confirmed"));
        return;
      } catch {
        // A missed poll is retried; the transaction itself is already submitted.
      }
    }
    fail("Still waiting for a block. Check the explorer for the final result.", txhash);
  }, []);

  return { state, run, reset, busy: state.phase !== "idle" && state.phase !== "success" && state.phase !== "failed" };
}
