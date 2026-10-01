"use client";

import { useCallback, useState } from "react";
import { QORECHAIN_DIANA } from "../lib/qorex-native";
import { chainFailureCopy, walletFailureCopy } from "../lib/qora-tx-copy";
import type { NativeAction } from "../lib/qora-native-actions";

export type TxPhase = "idle" | "preparing" | "signing" | "submitting" | "confirming" | "success" | "failed";
export type TxState = { phase: TxPhase; message: string; txhash: string; fee: string };

type Prepared = { chainId: string; accountNumber: string; bodyBytes: string; authInfoBytes: string; fee: { amount: string } };
type Broadcast = { txhash?: string; accepted?: boolean; code?: number; codespace?: string; error?: string };
type Status = { state?: "pending" | "included"; success?: boolean; code?: number; codespace?: string };

const IDLE: TxState = { phase: "idle", message: "", txhash: "", fee: "" };
const CONFIRM_ATTEMPTS = 30;

function toArray(base64: string) {
  return Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function toBase64(bytes: number[] | Record<string, number>) {
  return btoa(String.fromCharCode(...Object.values(bytes)));
}

function toHex(bytes: number[]) {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/**
 * Runs one native action end to end: the server builds and simulates it, QoreX
 * signs it, the server relays it, and the hook follows it into a block. Keys
 * stay in QoreX. Every failure is reported with controlled copy.
 */
export function useNativeTransaction() {
  const [state, setState] = useState<TxState>(IDLE);
  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(async (action: NativeAction) => {
    const fail = (message: string, txhash = "") => setState((current) => ({ ...current, phase: "failed", message, txhash }));
    const wallet = window.qorex?.native;
    if (!wallet) return fail("Install QoreX to sign QoreChain transactions.");

    setState({ ...IDLE, phase: "preparing" });
    let key;
    try {
      await wallet.enable(QORECHAIN_DIANA);
      key = await wallet.getKey(QORECHAIN_DIANA);
    } catch (error) {
      return fail(walletFailureCopy(error));
    }

    let prepared: Prepared;
    try {
      const response = await fetch("/api/native-tx/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: key.bech32Address, publicKey: key.pubKeyHex ?? toHex(key.pubKey), action }),
      });
      const data = await response.json() as Prepared & { error?: string };
      if (!response.ok) return fail(data.error ?? "The transaction could not be prepared.");
      prepared = data;
    } catch {
      return fail("The transaction could not be prepared. Try again shortly.");
    }

    setState((current) => ({ ...current, phase: "signing", fee: prepared.fee.amount }));
    let signed;
    try {
      signed = await wallet.signDirect(key.bech32Address, {
        bodyBytes: toArray(prepared.bodyBytes),
        authInfoBytes: toArray(prepared.authInfoBytes),
        chainId: prepared.chainId,
        accountNumber: prepared.accountNumber,
      });
    } catch (error) {
      console.error("QoreX signDirect failed", error);
      return fail(walletFailureCopy(error));
    }

    setState((current) => ({ ...current, phase: "submitting" }));
    let broadcast: Broadcast;
    try {
      const response = await fetch("/api/native-tx/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyBytes: toBase64(signed.signed.bodyBytes), authInfoBytes: toBase64(signed.signed.authInfoBytes), signature: signed.signature.signature }),
      });
      broadcast = await response.json() as Broadcast;
      if (!response.ok || !broadcast.txhash) return fail(broadcast.error ?? "The signed transaction could not be submitted.");
    } catch {
      return fail("The signed transaction could not be submitted. Try again shortly.");
    }
    if (!broadcast.accepted) return fail(chainFailureCopy(broadcast.codespace ?? "", broadcast.code ?? 0), broadcast.txhash);

    const txhash = broadcast.txhash;
    setState((current) => ({ ...current, phase: "confirming", txhash }));
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      await wait(2_000);
      try {
        const response = await fetch(`/api/native-tx/status?hash=${txhash}`, { cache: "no-store" });
        const status = await response.json() as Status;
        if (status.state !== "included") continue;
        if (!status.success) return fail(chainFailureCopy(status.codespace ?? "", status.code ?? 0), txhash);
        setState((current) => ({ ...current, phase: "success", message: "Confirmed on QoreChain Diana." }));
        window.dispatchEvent(new Event("qora:tx-confirmed"));
        return;
      } catch {
        // A missed poll is retried; the transaction itself is already submitted.
      }
    }
    fail("Still waiting for a block. Check the explorer for the final result.", txhash);
  }, []);

  return { state, run, reset, busy: state.phase !== "idle" && state.phase !== "success" && state.phase !== "failed" };
}
