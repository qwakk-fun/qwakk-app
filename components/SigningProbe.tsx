"use client";

import { useState } from "react";
import { QoraHeader } from "./QoraHeader";
import { QORECHAIN_DIANA } from "../lib/qorex-native";

type Step = { label: string; state: "done" | "failed" | "waiting" };
type Verdict = { title: string; detail: string; tone: "positive" | "negative" | "neutral" };

type ProbeTx = { chainId: string; accountNumber: string; bodyBytes: string; authInfoBytes: string };
type BroadcastReply = { txhash?: string; accepted?: boolean; code?: number; codespace?: string; error?: string };
type StatusReply = { state?: "pending" | "included"; success?: boolean; code?: number; codespace?: string; error?: string };

function base64ToArray(value: string) {
  return Array.from(atob(value), (character) => character.charCodeAt(0));
}

function arrayToBase64(value: number[] | Record<string, number>) {
  return btoa(String.fromCharCode(...Object.values(value)));
}

function toHex(bytes: number[]) {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/** Maps QoreX errors to controlled copy. The raw error only goes to the console. */
function signingFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("rejected")) return "The request was declined in QoreX.";
  if (message.includes("locked")) return "QoreX is locked. Unlock it and run the probe again.";
  if (message.includes("active network") || message.includes("unsupported chain")) return "QoreX is on a different network. Switch it to QoreChain Diana and run the probe again.";
  if (message.includes("not found in wallet") || message.includes("unknown signer")) return "QoreX could not match this account to its signer.";
  if (message.includes("quantum-safe")) return "QoreX refused to sign without the post-quantum layer.";
  return "QoreX did not return a signature. The browser console has the wallet's reason.";
}

/** Converts chain result codes into a controlled explanation. */
function checkTxVerdict(reply: BroadcastReply): Verdict {
  if (reply.accepted) {
    return {
      title: "Diana accepted the QoreX signature",
      detail: "CheckTx passed without a post-quantum layer. Native AMM transactions signed by QoreX can reach the chain.",
      tone: "positive",
    };
  }
  if (reply.codespace === "pqc") {
    return {
      title: "Diana requires the post-quantum layer",
      detail: `CheckTx refused the classical signature (pqc code ${reply.code}). A third-party PQC signing path from QoreX is still needed.`,
      tone: "negative",
    };
  }
  return {
    title: "Diana refused the transaction for another reason",
    detail: `CheckTx returned ${reply.codespace || "sdk"} code ${reply.code}. The server console has the chain log.`,
    tone: "neutral",
  };
}

export function SigningProbe() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [finalResult, setFinalResult] = useState("");
  const [txhash, setTxhash] = useState("");
  const [running, setRunning] = useState(false);

  function record(label: string, state: Step["state"]) {
    setSteps((current) => [...current, { label, state }]);
  }

  async function runProbe() {
    setSteps([]);
    setVerdict(null);
    setFinalResult("");
    setTxhash("");
    const wallet = window.qorex?.native;
    if (!wallet) {
      record("QoreX was not found in this browser", "failed");
      return;
    }

    setRunning(true);
    try {
      await wallet.enable(QORECHAIN_DIANA);
      const key = await wallet.getKey(QORECHAIN_DIANA);
      const publicKey = key.pubKeyHex ?? toHex(key.pubKey);
      record(`Wallet ${key.bech32Address.slice(0, 10)}…${key.bech32Address.slice(-6)} connected`, "done");

      const probeResponse = await fetch("/api/native-tx/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: key.bech32Address, publicKey }),
      });
      const probe = await probeResponse.json() as ProbeTx & { error?: string };
      if (!probeResponse.ok) {
        record(probe.error ?? "The probe transaction could not be prepared", "failed");
        return;
      }
      record("Probe swap built for pool #999999999", "done");

      let signed;
      try {
        signed = await wallet.signDirect(key.bech32Address, {
          bodyBytes: base64ToArray(probe.bodyBytes),
          authInfoBytes: base64ToArray(probe.authInfoBytes),
          chainId: probe.chainId,
          accountNumber: probe.accountNumber,
        });
      } catch (error) {
        console.error("QoreX signDirect failed", error);
        record(signingFailure(error), "failed");
        return;
      }
      record("QoreX returned a signature", "done");

      const broadcastResponse = await fetch("/api/native-tx/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyBytes: arrayToBase64(signed.signed.bodyBytes),
          authInfoBytes: arrayToBase64(signed.signed.authInfoBytes),
          signature: signed.signature.signature,
        }),
      });
      const broadcast = await broadcastResponse.json() as BroadcastReply;
      if (!broadcastResponse.ok || !broadcast.txhash) {
        record(broadcast.error ?? "The signed transaction could not be submitted", "failed");
        return;
      }
      setTxhash(broadcast.txhash);
      record("Submitted to QoreChain Diana", "done");
      setVerdict(checkTxVerdict(broadcast));
      if (!broadcast.accepted) return;

      for (let attempt = 0; attempt < 15; attempt += 1) {
        await wait(2_000);
        const statusResponse = await fetch(`/api/native-tx/status?hash=${broadcast.txhash}`, { cache: "no-store" });
        const status = await statusResponse.json() as StatusReply;
        if (status.state !== "included") continue;
        setFinalResult(status.success
          ? "Included in a block with success."
          : `Included in a block and failed with ${status.codespace || "sdk"} code ${status.code}. An amm failure is expected here because the pool does not exist.`);
        return;
      }
      setFinalResult("Not yet included after 30 seconds. Check the explorer link.");
    } catch {
      record("The probe stopped unexpectedly. Make sure QoreX is unlocked and set to QoreChain Diana.", "failed");
    } finally {
      setRunning(false);
    }
  }

  return <div className="app-shell">
    <QoraHeader page="home" />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <span className="kicker">Development only</span>
            <h1>Native signing probe</h1>
            <p>Checks whether QoreChain Diana accepts a QoreX signature on a native AMM message. The test swap targets a pool that does not exist, so no tokens change hands. Only the network fee of 0.06 QOR is spent.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void runProbe()} disabled={running}>{running ? "Running…" : "Run probe"}</button>
        </section>

        {steps.length > 0 && <section className="panel" aria-labelledby="probe-steps">
          <div className="panel-head"><span className="panel-title" id="probe-steps">Progress</span></div>
          <div className="info-list">{steps.map((step, index) => <div key={`${index}-${step.label}`}><span>{step.label}</span><b className={step.state === "failed" ? "down" : step.state === "done" ? "up" : "subtle"}>{step.state === "done" ? "✓ Done" : step.state === "failed" ? "× Stopped" : "…"}</b></div>)}</div>
        </section>}

        {verdict && <section className="panel" aria-labelledby="probe-result" style={{ marginTop: 16 }}>
          <div className="panel-head"><span className="panel-title" id="probe-result">{verdict.title}</span></div>
          <div className="panel-body" style={{ display: "grid", gap: 10 }}>
            <p className="muted">{verdict.detail}</p>
            {finalResult && <p className="muted">{finalResult}</p>}
            {txhash && <a className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} href={`https://explore.qore.network/tx/${txhash}`} target="_blank" rel="noreferrer">Open in explorer</a>}
          </div>
        </section>}
      </div>
    </main>
  </div>;
}
