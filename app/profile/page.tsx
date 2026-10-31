"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Wallet } from "lucide-react";
import { FaucetHint } from "../../components/FaucetHint";
import { QwakkHeader } from "../../components/QwakkHeader";
import { SiteFooter } from "../../components/SiteFooter";
import { TokenIcon } from "../../components/TokenIcon";
import { useAssets } from "../../components/useAssets";
import { useQorMarket } from "../../components/useQorMarket";
import { formatBaseAmount, type ResolvedAsset } from "../../lib/qwakk-assets";
import { formatUsdCompact } from "../../lib/qor-price";

type Balance = { denom: string; amount: string };
type Activity = { hash: string; timestamp: string; status: "success" | "failed"; label: string; direction: "in" | "out" | "action"; amount: string; denom: string };

/** Fixed copy for failed reads: route, proxy or parser text never reaches the page. */
const BALANCES_ERROR_COPY = "This is usually temporary. Try again in a moment.";
const ACTIVITY_ERROR_COPY = "Recent activity could not be loaded right now. Try again in a moment.";

/** Display only. A token with unknown decimals shows its raw base units, labeled as such. */
function formatBalance(amount: string, asset: ResolvedAsset) {
  return asset.decimals === null ? `${amount} base units` : formatBaseAmount(amount, asset.decimals);
}

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
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      setBalances(Array.isArray(data?.balances) ? data.balances : []);
    } catch {
      setError(BALANCES_ERROR_COPY);
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
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      setTransactions(Array.isArray(data?.transactions) ? data.transactions : []);
    } catch {
      setTransactionsError(ACTIVITY_ERROR_COPY);
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
      const savedAddress = window.localStorage.getItem("qwakk-wallet-address") ?? "";
      setAddress(savedAddress);
      void loadBalances(savedAddress);
      void loadTransactions(savedAddress);
      void loadPositions(savedAddress);
    }, 0);
    const refreshAfterTx = () => {
      const current = window.localStorage.getItem("qwakk-wallet-address") ?? "";
      void loadBalances(current);
      void loadPositions(current);
      void loadTransactions(current);
    };
    // A disconnect or a QoreX account switch replaces the stored address.
    const reloadForWallet = () => {
      const current = window.localStorage.getItem("qwakk-wallet-address") ?? "";
      setAddress(current);
      // Never show the previous wallet's data under the new address.
      setBalances([]);
      setTransactions([]);
      setPositions(null);
      void loadBalances(current);
      void loadTransactions(current);
      void loadPositions(current);
    };
    window.addEventListener("qwakk:tx-confirmed", refreshAfterTx);
    window.addEventListener("qwakk:wallet-change", reloadForWallet);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("qwakk:tx-confirmed", refreshAfterTx);
      window.removeEventListener("qwakk:wallet-change", reloadForWallet);
    };
  }, [loadBalances, loadTransactions, loadPositions]);

  const resolveAsset = useAssets([...balances.map((balance) => balance.denom), ...transactions.map((transaction) => transaction.denom)]);
  const qorBalance = balances.find((balance) => balance.denom === "uqor");
  const market = useQorMarket("1");
  // Under 1 QOR: a tester likely needs the faucet before trading.
  const lowOnQor = BigInt(qorBalance && /^\d+$/.test(qorBalance.amount) ? qorBalance.amount : "0") < BigInt(1_000_000);
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
    <QwakkHeader page="profile" onConnected={handleConnected} />
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
            <div className="stat-card stat"><span className="stat-label">QOR balance</span><span className="stat-value num">{qorBalance ? formatBalance(qorBalance.amount, resolveAsset(qorBalance.denom)) : "0"}</span><span className="subtle">{qorUsd === null ? "USD value not available" : `About ${formatUsdCompact(qorUsd)} at the CoinGecko price`}</span></div>
            <div className="stat-card stat" id="positions"><span className="stat-label">Pool positions</span><span className="stat-value num">{positions ?? "Not available"}</span><span className="subtle">{positionsNote}</span></div>
          </section>

          {!loading && !error && lowOnQor && <FaucetHint lead="This wallet is low on QOR, and every swap or pool action pays its network fee in QOR." className="faucet-hint-panel" />}

          <div className="portfolio-sections">
            <section className="panel assets-table" aria-labelledby="assets-title">
              <div className="panel-head"><span className="panel-title" id="assets-title">Assets</span><span className="subtle">{balances.length} {balances.length === 1 ? "token" : "tokens"}</span></div>
              {error ? <div className="empty"><h3>Balances could not be loaded</h3><p>{error}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadBalances(address)}>Try again</button></div>
                : loading ? <div className="empty"><p>Reading your balances…</p></div>
                : balances.length ? <div className="table">{balances.map((balance) => <div className="table-row" key={balance.denom}>
                  <span className="cell-main"><TokenIcon denom={balance.denom} size="regular" /><span><b>{resolveAsset(balance.denom).symbol}</b>{resolveAsset(balance.denom).name !== resolveAsset(balance.denom).symbol && <small>{resolveAsset(balance.denom).name}</small>}</span></span>
                  <b className="num">{formatBalance(balance.amount, resolveAsset(balance.denom))}</b>
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
                  <span className="num">{transaction.amount ? `${formatBalance(transaction.amount, resolveAsset(transaction.denom))} ${resolveAsset(transaction.denom).symbol}` : <ExternalLink size={14} className="subtle" />}</span>
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
