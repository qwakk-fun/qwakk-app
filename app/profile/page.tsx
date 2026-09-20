"use client";

import { useCallback, useEffect, useState } from "react";
import { QoraHeader } from "../../components/QoraHeader";
import { TokenIcon } from "../../components/TokenIcon";
import { assetForDenom, displaySymbol, formatBaseAmount } from "../../lib/qora-assets";
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";

type Balance = { denom: string; amount: string };
type Activity = { hash: string; timestamp: string; status: "success" | "failed"; label: string; direction: "in" | "out" | "action"; amount: string; denom: string };

function formatBalance(amount: string, denom: string) { return formatBaseAmount(amount, assetForDenom(denom)?.decimals ?? 0); }

export default function Profile() {
  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<Activity[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState("");

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

  const loadTransactions = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;
    setTransactionsLoading(true);
    setTransactionsError("");
    try {
      const response = await fetch(`/api/transactions?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? "Could not load recent activity");
      setTransactions(Array.isArray(data?.transactions) ? data.transactions : []);
    } catch (reason) {
      setTransactionsError(reason instanceof Error ? reason.message : "Could not load recent activity");
    } finally {
      setTransactionsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedAddress = window.localStorage.getItem("qora-wallet-address") ?? "";
      setAddress(savedAddress);
      void loadBalances(savedAddress);
      void loadTransactions(savedAddress);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadBalances, loadTransactions]);

  const qorBalance = balances.find((balance) => balance.denom === "uqor");
  const shortAddress = address ? `${address.slice(0, 10)}…${address.slice(-8)}` : "No wallet connected";
  const handleConnected = (walletAddress: string) => {
    setAddress(walletAddress);
    void loadBalances(walletAddress);
    void loadTransactions(walletAddress);
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
        <article className="position-card" id="positions"><span>LIQUIDITY POSITIONS</span><strong>0</strong><p>{loading ? "Checking your positions" : "Your active pool positions will appear here"}</p></article>
      </section>

      <section className="asset-section">
        <div className="asset-heading"><div><p className="kicker">YOUR ASSETS</p><h2>Tokens in your wallet</h2></div><span>{balances.length} assets</span></div>
        {error ? <div className="profile-empty compact"><h3>Couldn&apos;t load balances</h3><p>{error}</p><button type="button" className="outline-button" onClick={() => void loadBalances(address)}>Try again</button></div> : loading ? <div className="profile-empty compact"><p>Reading your wallet balances…</p></div> : balances.length ? <div className="asset-list">{balances.map((balance) => <article className="asset-row" key={balance.denom}><TokenIcon denom={balance.denom} size="regular" /> <div><strong>{displaySymbol(balance.denom)}</strong><small>{balance.denom}</small></div><b>{formatBalance(balance.amount, balance.denom)}</b></article>)}</div> : <div className="profile-empty compact"><span className="empty-mark">+</span><h3>No tokens to show yet</h3><p>When assets arrive in this wallet, they&apos;ll show up here automatically.</p></div>}
      </section>

      <section className="activity-section">
        <div className="asset-heading"><div><p className="kicker">RECENT ACTIVITY</p><h2>Latest transactions</h2></div><button type="button" className="outline-button" onClick={() => void loadTransactions(address)} disabled={transactionsLoading}>{transactionsLoading ? "Refreshing…" : "Refresh"}</button></div>
        {transactionsError ? <div className="activity-empty"><p>{transactionsError}</p><button type="button" className="outline-button" onClick={() => void loadTransactions(address)}>Try again</button></div> : transactionsLoading ? <div className="activity-empty"><p>Reading your recent activity…</p></div> : transactions.length ? <div className="activity-list">{transactions.map((transaction) => <a className="activity-row" href={`https://explore.qore.network/tx/${transaction.hash}`} target="_blank" rel="noreferrer" key={transaction.hash}><span className={`activity-icon ${transaction.direction}`}>{transaction.direction === "in" ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><span><b>{transaction.label}</b><small>{transaction.timestamp ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(transaction.timestamp)) : "Confirmed"} · {transaction.hash.slice(0, 10)}…</small></span><span className="activity-value">{transaction.amount ? `${formatBalance(transaction.amount, transaction.denom)} ${displaySymbol(transaction.denom)}` : "View details"}<ExternalLink size={13} /></span></a>)}</div> : <div className="activity-empty"><p>No recent transactions found for this wallet yet.</p></div>}
      </section>

      <section className="profile-note"><span>QORA WALLET</span><p>Your balances and liquidity positions, collected in one clear view.</p></section>

    </>}
  </main>;
}
