"use client";

import { useCallback, useEffect, useState } from "react";
import { QoraHeader } from "../../components/QoraHeader";

type Balance = { denom: string; amount: string };

function tokenName(denom: string) {
  if (denom === "uqor") return "QOR";
  return denom.replace(/^u/, "").toUpperCase();
}

function formatBalance(amount: string, denom: string) {
  if (!/^\d+$/.test(amount)) return amount;
  const decimals = denom.startsWith("u") ? 6 : 0;
  if (!decimals) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "").slice(0, 4);
  return fraction ? `${whole}.${fraction}` : whole;
}

export default function Profile() {
  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadBalances = useCallback(async (walletAddress: string) => {
    if (!walletAddress) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/account?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Could not load balances");
      setBalances(Array.isArray(data?.balances) ? data.balances : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load balances");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const savedAddress = window.localStorage.getItem("qora-wallet-address") ?? "";
    setAddress(savedAddress);
    void loadBalances(savedAddress);
  }, [loadBalances]);

  const qorBalance = balances.find((balance) => balance.denom === "uqor");
  const otherBalances = balances.filter((balance) => balance.denom !== "uqor");
  const shortAddress = address ? `${address.slice(0, 10)}…${address.slice(-8)}` : "No wallet connected";
  const handleConnected = (walletAddress: string) => {
    setAddress(walletAddress);
    void loadBalances(walletAddress);
  };

  return <main className="profile-shell">
    <QoraHeader page="profile" onConnected={handleConnected} />

    <section className="profile-hero">
      <p className="eyebrow"><span className="status-dot online" /> WALLET OVERVIEW</p>
      <div className="profile-title-row"><div><h1>Your Qora profile.</h1><p>See the assets and liquidity linked to your wallet, all in one place.</p></div><button type="button" className="outline-button" onClick={() => void loadBalances(address)} disabled={loading || !address}>{loading ? "Refreshing…" : "Refresh balances"}</button></div>
    </section>

    {!address ? <section className="profile-empty"><span className="empty-mark">+</span><h2>Connect a wallet first</h2><p>Use Connect wallet above and your balances will appear here.</p></section> : <>
      <section className="wallet-overview">
        <article className="address-card"><span>CONNECTED WALLET</span><strong>{shortAddress}</strong><p>{address}</p></article>
        <article className="qor-card"><span>QOR BALANCE</span><strong>{qorBalance ? formatBalance(qorBalance.amount, qorBalance.denom) : "0"}</strong><p>QOR · available in your wallet</p></article>
        <article className="position-card"><span>LIQUIDITY POSITIONS</span><strong>0</strong><p>{loading ? "Checking your positions" : "Your active pool positions will appear here"}</p></article>
      </section>

      <section className="asset-section">
        <div className="asset-heading"><div><p className="kicker">YOUR ASSETS</p><h2>Tokens in your wallet</h2></div><span>{balances.length} assets</span></div>
        {error ? <div className="profile-empty compact"><h3>Couldn&apos;t load balances</h3><p>{error}</p><button type="button" className="outline-button" onClick={() => void loadBalances(address)}>Try again</button></div> : loading ? <div className="profile-empty compact"><p>Reading your wallet balances…</p></div> : balances.length ? <div className="asset-list">{balances.map((balance) => <article className="asset-row" key={balance.denom}><span className={`asset-orb ${balance.denom === "uqor" ? "qor" : "other"}`} /> <div><strong>{tokenName(balance.denom)}</strong><small>{balance.denom}</small></div><b>{formatBalance(balance.amount, balance.denom)}</b></article>)}</div> : <div className="profile-empty compact"><span className="empty-mark">+</span><h3>No tokens to show yet</h3><p>When assets arrive in this wallet, they&apos;ll show up here automatically.</p></div>}
      </section>

      <section className="profile-note"><span>QORA WALLET</span><p>Your balances and liquidity positions, collected in one clear view.</p></section>
    </>}
  </main>;
}
