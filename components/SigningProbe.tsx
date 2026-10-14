"use client";

import { useState } from "react";
import { QwakkHeader } from "./QwakkHeader";
import { QORECHAIN_DIANA, qorexSupport, type QoreXMessage } from "../lib/qorex-native";
import { BRAND } from "../lib/brand";
import { formatBaseAmount } from "../lib/qwakk-assets";
import { QOREX_MISSING_COPY, QOREX_OUTDATED_COPY, walletFailure } from "../lib/qwakk-tx-copy";

type Step = { label: string; state: "done" | "failed" };
type Verdict = { title: string; detail: string };
type Outcome = { txhash: string; code: string; height: string; shield: string };

type ProbeTx = {
  chainId: string;
  messages: QoreXMessage[];
  memo: string;
  gasLimit: string;
  fee: { amount: string };
  pqcKeyRegistered: boolean | null;
  error?: string;
};
type StatusReply = { state?: "pending" | "included"; success?: boolean; code?: number; codespace?: string; height?: string };

const SHIELD_COPY: Record<string, string> = {
  shielded: "QoreX reports the block includes its post-quantum layer.",
  pending: "QoreX stopped waiting before the block, so it could not confirm the post-quantum layer yet.",
  downgraded: "QoreX reports the block does not include its post-quantum layer.",
  classical: "QoreX reports a classical signature only.",
};

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-F]{64}$/i.test(value);
}

function short(address: string) {
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

/**
 * Development-only probe for the QoreX 0.3.5 `signAndBroadcast` path. It sends
 * 1 uqor (0.000001 QOR) from the connected address to itself, which needs no pool and uses
 * the same bank transfer as the interface fee. It runs only on click.
 */
export function SigningProbe() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);

  function record(label: string, state: Step["state"]) {
    setSteps((current) => [...current, { label, state }]);
  }

  async function runProbe() {
    setSteps([]);
    setVerdict(null);
    setOutcome(null);

    const support = qorexSupport(window.qorex?.native);
    if (support.state !== "ready") {
      record(support.state === "missing" ? QOREX_MISSING_COPY : QOREX_OUTDATED_COPY, "failed");
      return;
    }
    const wallet = support.wallet;
    record("QoreX supports signAndBroadcast", "done");

    setRunning(true);
    try {
      let address: string;
      try {
        await wallet.enable(QORECHAIN_DIANA);
        address = (await wallet.getKey(QORECHAIN_DIANA)).bech32Address;
      } catch (error) {
        record(walletFailure(error).copy, "failed");
        return;
      }
      record(`Wallet ${short(address)} connected`, "done");

      const probeResponse = await fetch("/api/native-tx/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const probe = await probeResponse.json() as ProbeTx;
      if (!probeResponse.ok) {
        record(probe.error ?? "The probe transaction could not be prepared", "failed");
        return;
      }
      record(`0.000001 QOR self-transfer simulated on QoreChain Diana. Gas limit ${probe.gasLimit}, expected network fee ${formatBaseAmount(probe.fee.amount, 6, 6)} QOR`, "done");
      if (probe.pqcKeyRegistered === false) record("This wallet has no post-quantum key on chain yet. QoreX will register it first in its own transaction", "done");

      let result;
      try {
        result = await wallet.signAndBroadcast({ chainId: probe.chainId, messages: probe.messages, memo: probe.memo, gasLimit: probe.gasLimit });
      } catch (error) {
        console.error("QoreX signAndBroadcast failed", error);
        const failure = walletFailure(error);
        record(failure.copy, "failed");
        if (failure.kind === "chain") {
          setVerdict({
            title: "Diana refused the wallet-built transaction",
            detail: `CheckTx returned ${failure.codespace || "an unknown codespace"} code ${failure.code}. Nothing was included in a block.`,
          });
        } else if (failure.kind === "onchain") {
          setVerdict({
            title: "The transaction reached a block but failed",
            detail: `${failure.code !== undefined ? `QoreX reported block result code ${failure.code}. ` : ""}The transaction passed CheckTx, so Diana took it in, but it did not succeed. QoreX did not return the hash, so check its activity list.`,
          });
        }
        return;
      }

      if (!isHash(result?.txHash)) {
        record("QoreX did not return a transaction hash", "failed");
        return;
      }
      const txhash = result.txHash;
      const shield = typeof result.shield === "string" ? result.shield : "";
      record("QoreX approved, signed and broadcast the transaction", "done");

      let code = String(result.code ?? "");
      // Only a real block height counts. Zero, missing or a "pending" shield means
      // QoreX stopped waiting before the block, so follow the hash here.
      let height = Number(result.height) > 0 && shield !== "pending" ? String(result.height) : "";
      let success = result.code === 0 && height !== "";
      setOutcome({ txhash, code: height ? code : "", height, shield });
      if (!height) setVerdict({ title: "Broadcast, waiting for a block", detail: "QoreX broadcast the transaction. Checking QoreChain Diana for the block result." });
      for (let attempt = 0; attempt < 15 && !height; attempt += 1) {
        await wait(2_000);
        try {
          const statusResponse = await fetch(`/api/native-tx/status?hash=${txhash}`, { cache: "no-store" });
          const status = await statusResponse.json() as StatusReply;
          if (status.state !== "included") continue;
          code = String(status.code ?? "");
          height = Number(status.height) > 0 ? String(status.height) : "";
          success = status.success === true;
        } catch {
          // A missed poll is retried. The hash stays on screen either way.
        }
      }
      setOutcome({ txhash, code: height ? code : "", height, shield });

      if (success) {
        setVerdict({
          title: "Diana accepted the QoreX post-quantum transaction",
          detail: `QoreX built, signed and broadcast a 0.000001 QOR transfer to your own address, and it landed in a block with code 0. The wallet path works, and so does the bank transfer ${BRAND.name} uses for its interface fee. Only the network fee was spent.`,
        });
      } else if (height) {
        setVerdict({
          title: "Included in a block but failed",
          detail: `The block result code is ${code}. Open the explorer for details.`,
        });
      } else {
        setVerdict({
          title: "Broadcast, not yet in a block",
          detail: "QoreX broadcast the transaction, but it was not found in a block within about a minute. Check the explorer link.",
        });
      }
    } catch {
      record("The probe stopped unexpectedly. Make sure QoreX is unlocked and set to QoreChain Diana.", "failed");
    } finally {
      setRunning(false);
    }
  }

  return <div className="app-shell">
    <QwakkHeader page="home" />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <span className="kicker">Development only</span>
            <h1>Native signing probe</h1>
            <p>Asks QoreX to approve, sign and broadcast a 0.000001 QOR transfer from your wallet to itself on QoreChain Diana. No pool is needed and no funds leave your wallet except the network fee (about 0.03 QOR). QoreX must be set to QoreChain Diana: tap the version number at the bottom of QoreX 7 times to turn on Developer mode, then choose Switch to testnet (diana).</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void runProbe()} disabled={running}>{running ? "Running…" : "Run probe"}</button>
        </section>

        {steps.length > 0 && <section className="panel" aria-labelledby="probe-steps">
          <div className="panel-head"><span className="panel-title" id="probe-steps">Progress</span></div>
          <div className="info-list">{steps.map((step, index) => <div key={`${index}-${step.label}`}><span>{step.label}</span><b className={step.state === "failed" ? "down" : "up"}>{step.state === "done" ? "✓ Done" : "× Stopped"}</b></div>)}</div>
        </section>}

        {verdict && <section className="panel" aria-labelledby="probe-result" style={{ marginTop: 16 }}>
          <div className="panel-head"><span className="panel-title" id="probe-result">{verdict.title}</span></div>
          <div className="panel-body" style={{ display: "grid", gap: 10 }}>
            <p className="muted">{verdict.detail}</p>
            {outcome && <div className="info-list">
              <div><span>Transaction hash</span><b style={{ wordBreak: "break-all" }}>{outcome.txhash}</b></div>
              <div><span>Result code</span><b>{outcome.code || "Unknown"}</b></div>
              <div><span>Block height</span><b>{outcome.height || "Not yet included"}</b></div>
              {SHIELD_COPY[outcome.shield] && <div><span>Post-quantum layer</span><b>{SHIELD_COPY[outcome.shield]}</b></div>}
            </div>}
            {outcome && <a className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} href={`https://explore.qore.network/tx/${outcome.txhash}`} target="_blank" rel="noreferrer">Open in explorer</a>}
          </div>
        </section>}
      </div>
    </main>
  </div>;
}
