"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3, ExternalLink, KeyRound, Landmark, LockKeyhole, PauseCircle, ShieldCheck } from "lucide-react";
import { QwakkHeader } from "./QwakkHeader";
import { SiteFooter } from "./SiteFooter";
import { TokenIcon } from "./TokenIcon";
import { BRAND } from "../lib/brand";
import { explorerTxUrl } from "../lib/qwakk-network";
import type { VaultSnapshot, VaultWindow } from "../lib/qwakk-vault";
import { vaultActionState, vaultDuration } from "../lib/qwakk-vault-view";

const REFRESH_MS = 15_000;

const ACTION_LABELS: Record<string, string> = {
  Withdraw: "Withdrawal",
  SetDailyCap: "Daily cap change",
  SetTimelock: "Timelock change",
  SetOwner: "Owner change",
  SetApprover: "Approver change",
  SetGuardian: "Guardian change",
};

type Loaded = { snapshot: VaultSnapshot; offset: number } | null;

function short(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function windowText(w: VaultWindow | null) {
  if (!w) return "Unknown";
  if (!w.found || !w.live) return "Closed";
  const scope = w.scope === "vault" ? "scoped to this vault" : w.scope === "unscoped" ? "unscoped" : w.scope === "native-only" ? "QOR transfers only" : "scoped elsewhere";
  return `Open, ${scope}, ${w.remainingTxs} tx left`;
}

function TxLink({ hash, label }: { hash: string | null; label: string }) {
  if (!hash) return null;
  return <a className="vault-tx" href={explorerTxUrl(hash)} target="_blank" rel="noreferrer" aria-label={`${label}: open transaction in the QoreChain explorer`}>{label}<ExternalLink size={13} aria-hidden="true" /></a>;
}

export function VaultView() {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    async function load() {
      try {
        const response = await fetch("/api/vault", { cache: "no-store" });
        const snapshot = (await response.json()) as VaultSnapshot;
        const offset = snapshot.status === "ok" ? snapshot.chainTime - Math.floor(Date.now() / 1000) : 0;
        if (alive.current) setLoaded({ snapshot: snapshot.status ? snapshot : { status: "unavailable" }, offset });
      } catch {
        if (alive.current) setLoaded((prev) => prev ?? { snapshot: { status: "unavailable" }, offset: 0 });
      }
    }
    load();
    const poll = window.setInterval(load, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      alive.current = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const snapshot = loaded?.snapshot;
  const chainNow = now + (loaded?.offset ?? 0);
  const sameAccount = snapshot?.status === "ok" && snapshot.owner.toLowerCase() === snapshot.approver.toLowerCase();
  const remainingToday: Record<string, string> = {};
  if (snapshot?.status === "ok") for (const asset of snapshot.assets) remainingToday[asset.token.toLowerCase()] = asset.remainingTodayRaw;

  return <div className="app-shell">
    <QwakkHeader page="vault" />
    <main className="app-main">
      <div className="container vault">
        <section className="page-head">
          <div>
            <span className="kicker">Post-quantum treasury</span>
            <h1>The Pond Vault</h1>
            <p>A vault on the QoreChain EVM built to hold {BRAND.name}&apos;s interface fees. It is not receiving swap fees yet. Withdrawals and rule changes need two signatures, one of them post-quantum, and a wait anyone can watch.</p>
          </div>
        </section>

        <section className="fee-promise" aria-labelledby="vault-promise">
          <span className="fee-promise-icon"><ShieldCheck size={22} /></span>
          <div>
            <h2 id="vault-promise">Checked on chain by ML-DSA-87</h2>
            <p>Every withdrawal or rule change needs the owner&apos;s transaction plus an ML-DSA-87 (FIPS 204) signature that QoreChain&apos;s pqcVerify precompile checks inside the contract. Then it waits out a timelock, and withdrawals stay within a daily cap.</p>
          </div>
        </section>

        {!snapshot && <section className="panel vault-state" aria-busy="true"><div className="empty"><h3>Loading the vault</h3><p>Reading QoreChain Diana.</p></div></section>}

        {snapshot?.status === "unconfigured" && <section className="panel vault-state">
          <div className="empty">
            <span className="empty-icon"><Landmark size={20} /></span>
            <h3>Not deployed on this network yet</h3>
            <p>The Pond Vault runs on QoreChain Diana. Its balances, guards and queue show up here once its address is set.</p>
          </div>
        </section>}

        {snapshot?.status === "unavailable" && <section className="panel vault-state">
          <div className="empty">
            <span className="empty-icon"><Landmark size={20} /></span>
            <h3>Vault data is unavailable right now</h3>
            <p>QoreChain Diana did not answer. This page tries again on its own.</p>
          </div>
        </section>}

        {snapshot?.status === "ok" && <>
          {snapshot.paused && <section className="vault-paused" role="status"><PauseCircle size={18} aria-hidden="true" /><span>Withdrawals are paused. Lifting the pause needs a new ML-DSA-87 approval.</span></section>}

          <div className="fee-split">
            <section className="panel" aria-labelledby="vault-balances">
              <div className="panel-head"><span className="panel-title" id="vault-balances">Balances and daily caps</span></div>
              <div className="table vault-balances">
                <div className="table-row table-head"><span>Asset</span><span className="num">Balance</span><span className="num hide-sm">Daily cap</span><span className="num">Left today</span></div>
                {snapshot.assets.map((asset) => <div className="table-row" key={asset.symbol}>
                  <span className="cell-main"><TokenIcon denom={asset.denom} size="small" /><b>{asset.symbol}</b></span>
                  <span className="num">{asset.balance}</span>
                  <span className="num hide-sm">{asset.dailyCap === "0" ? "Locked" : asset.dailyCap}</span>
                  <span className="num">{asset.remainingToday}</span>
                </div>)}
              </div>
              <p className="panel-note">A daily cap of zero locks that asset: it can come in but not go out. Caps reset at 00:00 UTC.</p>
            </section>

            <section className="panel" aria-labelledby="vault-guards">
              <div className="panel-head"><span className="panel-title" id="vault-guards"><LockKeyhole size={16} aria-hidden="true" /> Guards</span></div>
              <div className="info-list">
                <div><span>Status</span><b>{snapshot.paused ? "Paused" : "Active"}</b></div>
                <div><span>Timelock</span><b className="num">{vaultDuration(snapshot.timelockSeconds)}</b></div>
                <div><span>Approver key</span><b>{snapshot.approverKeyUsable ? "ML-DSA-87, proven" : "Not usable"}</b></div>
                <div><span>Approvals used</span><b className="num">{snapshot.nonce}</b></div>
                <div><span>Owner window</span><b>{windowText(snapshot.ownerWindow)}</b></div>
                <div><span>Owner</span><b className="mono" title={snapshot.owner}>{short(snapshot.owner)}</b></div>
                <div><span>Approver</span>{sameAccount ? <b>Same account as owner</b> : <b className="mono" title={snapshot.approver}>{short(snapshot.approver)}</b>}</div>
                <div><span>Guardian</span><b className="mono" title={snapshot.guardian ?? undefined}>{snapshot.guardian ? short(snapshot.guardian) : "None"}</b></div>
              </div>
              {sameAccount && <p className="panel-note">Owner and approver are one account, so one recovery phrase holds both keys. A separate approver account would make the post-quantum key independent.</p>}
              <p className="panel-note vault-address"><span>Contract</span><code>{snapshot.address}</code></p>
            </section>
          </div>

          <section className="panel vault-queue" aria-labelledby="vault-queue">
            <div className="panel-head"><span className="panel-title" id="vault-queue"><Clock3 size={16} aria-hidden="true" /> Queue</span><span className="subtle num">{snapshot.actionCount} total</span></div>
            {snapshot.actions.length === 0
              ? <div className="empty"><span className="empty-icon"><KeyRound size={20} /></span><h3>No actions yet</h3><p>Approved actions land here with a countdown until they can run.</p></div>
              : <div className="table">
                <div className="table-row table-head"><span>Action</span><span className="hide-sm">Details</span><span>State</span><span className="end">Transactions</span></div>
                {snapshot.actions.map((row) => {
                  const state = vaultActionState(row, chainNow, { paused: snapshot.paused, remainingToday });
                  return <div className="table-row" key={row.id}>
                    <span className="cell-main"><span className="subtle num">#{row.id}</span><b>{ACTION_LABELS[row.action] ?? row.action}</b></span>
                    <span className="hide-sm vault-details">
                      {row.amount && <span className="num">{row.amount}{row.symbol ? ` ${row.symbol}` : ""}</span>}
                      {row.to && <span className="mono subtle" title={row.to}>to {short(row.to)}</span>}
                    </span>
                    <span><span className={`vault-chip is-${state.tone}`}>{state.label}</span></span>
                    <span className="end vault-links"><TxLink hash={row.queuedTx} label="Queued" /><TxLink hash={row.settledTx} label={row.status === "cancelled" ? "Cancelled" : "Executed"} /></span>
                  </div>;
                })}
              </div>}
            <p className="panel-note">Read only. Approvals are signed offline by the vault&apos;s approver, never in this browser. Anyone can run a ready action; nobody can skip the wait.</p>
          </section>
        </>}
      </div>
    </main>
    <SiteFooter />
  </div>;
}
