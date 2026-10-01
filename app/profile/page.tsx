"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Wallet } from "lucide-react";
import { QoraHeader } from "../../components/QoraHeader";
import { SiteFooter } from "../../components/SiteFooter";
import { TokenIcon } from "../../components/TokenIcon";
import { useQorMarket } from "../../components/useQorMarket";
import { assetForDenom, displaySymbol, formatBaseAmount } from "../../lib/qora-assets";
import { formatUsdCompact } from "../../lib/qor-price";

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
  // Null means positions could not be read, so the card never shows a misleading zero.
  const [positions, setPositions] = useState<number | null>(null);
  const [positionsLoading, setPositionsLoading] = useState(true);

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

  const loadPositions = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;
    setPositionsLoading(true);
    try {
      const response = await fetch(`/api/positions?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      const data = await response.json() as { positions?: unknown[] };
      setPositions(response.ok && Array.isArray(data.positions) ? data.positions.length : null);
    } catch {
      setPositions(null);
    } finally {
      setPositionsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedAddress = window.localStorage.getItem("qora-wallet-address") ?? "";
      setAddress(savedAddress);
      void loadBalances(savedAddress);
      void loadTransactions(savedAddress);
      void loadPositions(savedAddress);
    }, 0);
    const refreshAfterTx = () => {
      const current = window.localStorage.getItem("qora-wallet-address") ?? "";
      void loadBalances(current);
      void loadPositions(current);
      void loadTransactions(current);
    };
    window.addEventListener("qora:tx-confirmed", refreshAfterTx);
    return () => { window.clearTimeout(timer); window.removeEventListener("qora:tx-confirmed", refreshAfterTx); };
  }, [loadBalances, loadTransactions, loadPositions]);

  const qorBalance = balances.find((balance) => balance.denom === "uqor");
  const market = useQorMarket("1");
  // Display only: a float is precise enough to show a dollar estimate.
  const qorUsd = qorBalance && market.data ? Number(formatBaseAmount(qorBalance.amount, 6, 6)) * market.data.price : null;
  const positionsNote = positionsLoading
    ? "Checking your positions"
    : positions === null
      ? "Positions are temporarily unavailable"
      : positions
        ? "Pools where this wallet holds a share"
        : "This wallet holds no pool shares yet";
  const shortAddress = address ? `${address.slice(0, 10)}…${address.slice(-8)}` : "No wallet connected";
  const handleConnected = (walletAddress: string) => {
    setAddress(walletAddress);
    void loadBalances(walletAddress);
    void loadTransactions(walletAddress);
    void loadPositions(walletAddress);
  };
  return <div className="app-shell">
    <QoraHeader page="profile" onConnected={handleConnected} />
    <main className="app-main">
      <div className="container">
        <section className="page-head">
          <div>
            <h1>Portfolio</h1>
            <p>Balances, pool shares and recent activity for your QoreChain wallet.</p>
          </div>
          {address && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void loadBalances(address); void loadPositions(address); void loadTransactions(address); }} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}
        </section>

        {!address ? <section className="panel empty">
          <span className="empty-icon"><Wallet size={18} /></span>
          <h3>Connect a wallet to see your portfolio</h3>
          <p>Use Connect wallet at the top of the page. Only your public address is shared.</p>
        </section> : <>
          <section className="overview-grid" aria-label="Wallet overview">
            <div className="stat-card stat"><span className="stat-label">Connected wallet</span><span className="stat-value">{shortAddress}</span><span className="address-value">{address}</span></div>
            <div className="stat-card stat"><span className="stat-label">QOR balance</span><span className="stat-value num">{qorBalance ? formatBalance(qorBalance.amount, qorBalance.denom) : "0"}</span><span className="subtle">{qorUsd === null ? "USD value not available" : `About ${formatUsdCompact(qorUsd)} at the CoinGecko price`}</span></div>
            <div className="stat-card stat" id="positions"><span className="stat-label">Pool positions</span><span className="stat-value num">{positions ?? "Not available"}</span><span className="subtle">{positionsNote}</span></div>
          </section>

          <div className="portfolio-sections">
            <section className="panel assets-table" aria-labelledby="assets-title">
              <div className="panel-head"><span className="panel-title" id="assets-title">Assets</span><span className="subtle">{balances.length} {balances.length === 1 ? "token" : "tokens"}</span></div>
              {error ? <div className="empty"><h3>Balances could not be loaded</h3><p>{error}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadBalances(address)}>Try again</button></div>
                : loading ? <div className="empty"><p>Reading your balances…</p></div>
                : balances.length ? <div className="table">{balances.map((balance) => <div className="table-row" key={balance.denom}>
                  <span className="cell-main"><TokenIcon denom={balance.denom} size="regular" /><span><b>{displaySymbol(balance.denom)}</b><small>{balance.denom}</small></span></span>
                  <b className="num">{formatBalance(balance.amount, balance.denom)}</b>
                </div>)}</div>
                : <div className="empty"><h3>No tokens yet</h3><p>Assets sent to this wallet will appear here.</p></div>}
            </section>

            <section className="panel activity-table" aria-labelledby="activity-title">
              <div className="panel-head"><span className="panel-title" id="activity-title">Recent activity</span>{transactionsLoading && <span className="subtle">Refreshing…</span>}</div>
              {transactionsError ? <div className="empty"><p>{transactionsError}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadTransactions(address)}>Try again</button></div>
                : transactionsLoading && !transactions.length ? <div className="empty"><p>Reading your recent activity…</p></div>
                : transactions.length ? <div className="table">{transactions.map((transaction) => <a className="table-row" href={`https://explore.qore.network/tx/${transaction.hash}`} target="_blank" rel="noreferrer" key={transaction.hash}>
                  <span className={`activity-icon ${transaction.direction}`}>{transaction.direction === "in" ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span>
                  <span className="cell-main"><span><b>{transaction.label}</b><small>{transaction.timestamp ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(transaction.timestamp)) : "Confirmed"} · {transaction.hash.slice(0, 10)}…</small></span></span>
                  <span className="num">{transaction.amount ? `${formatBalance(transaction.amount, transaction.denom)} ${displaySymbol(transaction.denom)}` : <ExternalLink size={14} className="subtle" />}</span>
                </a>)}</div>
                : <div className="empty"><p>No recent transactions for this wallet.</p></div>}
            </section>
          </div>
        </>}
      </div>
    </main>
    <SiteFooter />
  </div>;
}
