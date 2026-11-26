"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, Check, Copy, RefreshCw, Send, Wallet } from "lucide-react";
import { FaucetHint } from "../../components/FaucetHint";
import { Identicon } from "../../components/Identicon";
import { useNetworkCopy } from "../../components/NetworkContext";
import { ActivityPanel, PoolsPanel, TokensPanel, type Activity, type Position, type TokenRow } from "../../components/PortfolioLists";
import { ProfitLoss } from "../../components/ProfitLoss";
import { QwakkHeader } from "../../components/QwakkHeader";
import { ReceiveSheet } from "../../components/ReceiveSheet";
import { RewardsPortfolio } from "../../components/RewardsPortfolio";
import { SendSheet, type SendableToken } from "../../components/SendSheet";
import { SiteFooter } from "../../components/SiteFooter";
import { useAssets } from "../../components/useAssets";
import { useCopy } from "../../components/useCopy";
import { useFeatures } from "../../components/useFeatures";
import { usePnl } from "../../components/usePnl";
import { useQorMarket } from "../../components/useQorMarket";
import { useWalletNetwork } from "../../components/useWalletNetwork";
import { formatBaseAmount } from "../../lib/qwakk-assets";
import { formatUsdCompact } from "../../lib/qor-price";
import { formatPnlPercent, formatQor, formatSignedQor, pnlTone } from "../../lib/qwakk-pnl-display";
import { allocation, compareHoldings, formatBps, portfolioTotal, tokenValueUqor } from "../../lib/qwakk-portfolio";
import { isSendableDenom } from "../../lib/qwakk-send-action";

type Balance = { denom: string; amount: string };
type Tab = "tokens" | "pools" | "activity" | "pnl";

const TABS: { id: Tab; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "pools", label: "Pools" },
  { id: "activity", label: "Activity" },
  { id: "pnl", label: "Profit and loss" },
];
/** Older links pointed at the cards this page used to have. */
const HASH_TABS: Record<string, Tab> = { tokens: "tokens", pools: "pools", positions: "pools", rewards: "pools", activity: "activity", pnl: "pnl" };
const SLICE_CLASSES = ["is-first", "is-second", "is-third", "is-rest"];
const ONE_QOR = BigInt(1_000_000);

function readAddress() {
  return window.localStorage.getItem("qwakk-wallet-address") ?? "";
}

export default function Profile() {
  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [transactions, setTransactions] = useState<Activity[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState(false);
  // Null means positions could not be read, so the page never shows a misleading zero.
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [positionsLoading, setPositionsLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("tokens");
  const [sheet, setSheet] = useState<{ kind: "send"; denom: string | null } | { kind: "receive" } | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ tokens: null, pools: null, activity: null, pnl: null });
  // The wallet the page currently shows. A slow reply for an earlier wallet is dropped, never shown under the new one.
  const activeWallet = useRef("");

  const loadBalances = useCallback(async (walletAddress: string) => {
    if (!walletAddress) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`/api/account?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (walletAddress !== activeWallet.current) return;
      setBalances(Array.isArray(data?.balances) ? data.balances : []);
    } catch {
      // Fixed copy only: route, proxy or parser text never reaches the page.
      if (walletAddress === activeWallet.current) setError(true);
    } finally {
      if (walletAddress === activeWallet.current) setLoading(false);
    }
  }, []);

  const loadTransactions = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;
    setTransactionsLoading(true);
    setTransactionsError(false);
    try {
      const response = await fetch(`/api/transactions?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (walletAddress !== activeWallet.current) return;
      setTransactions(Array.isArray(data?.transactions) ? data.transactions : []);
    } catch {
      if (walletAddress === activeWallet.current) setTransactionsError(true);
    } finally {
      if (walletAddress === activeWallet.current) setTransactionsLoading(false);
    }
  }, []);

  const loadPositions = useCallback(async (walletAddress: string) => {
    if (!walletAddress) return;
    setPositionsLoading(true);
    try {
      const response = await fetch(`/api/positions?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      const data = await response.json() as { positions?: Position[] };
      if (walletAddress !== activeWallet.current) return;
      setPositions(response.ok && Array.isArray(data.positions) ? data.positions : null);
    } catch {
      if (walletAddress === activeWallet.current) setPositions(null);
    } finally {
      if (walletAddress === activeWallet.current) setPositionsLoading(false);
    }
  }, []);

  const loadAll = useCallback((walletAddress: string) => {
    activeWallet.current = walletAddress;
    void loadBalances(walletAddress);
    void loadTransactions(walletAddress);
    void loadPositions(walletAddress);
  }, [loadBalances, loadTransactions, loadPositions]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedAddress = readAddress();
      setAddress(savedAddress);
      loadAll(savedAddress);
      const fromHash = HASH_TABS[window.location.hash.slice(1)];
      if (fromHash) setTab(fromHash);
    }, 0);
    const refreshAfterTx = () => loadAll(readAddress());
    // A disconnect or a QoreX account switch replaces the stored address.
    const reloadForWallet = () => {
      const current = readAddress();
      setAddress(current);
      // Never show the previous wallet's data under the new address, and never keep its Send sheet open.
      setBalances([]);
      setTransactions([]);
      setPositions(null);
      setSheet(null);
      loadAll(current);
    };
    window.addEventListener("qwakk:tx-confirmed", refreshAfterTx);
    window.addEventListener("qwakk:wallet-change", reloadForWallet);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("qwakk:tx-confirmed", refreshAfterTx);
      window.removeEventListener("qwakk:wallet-change", reloadForWallet);
    };
  }, [loadAll]);

  const features = useFeatures();
  const { label: networkLabel, isTestnet } = useNetworkCopy();
  const walletNetwork = useWalletNetwork(address, features.network);
  // Profit and loss reloads itself after the wallet's own confirmed swaps and on a wallet change.
  const pnl = usePnl(address);
  const market = useQorMarket("1");
  const copier = useCopy();
  const resolveAsset = useAssets([
    ...balances.map((balance) => balance.denom),
    ...transactions.map((transaction) => transaction.denom),
    ...(positions ?? []).flatMap((position) => [position.tokenA, position.tokenB]),
  ]);

  const qorUsd = market.data?.price ?? null;
  const prices = useMemo(() => new Map((pnl.report?.tokens ?? []).map((token) => [token.denom, token.price])), [pnl.report]);

  const rows = useMemo<TokenRow[]>(() => balances
    .filter((balance) => /^\d+$/.test(balance.amount) && BigInt(balance.amount) > BigInt(0))
    .map((balance) => {
      const asset = resolveAsset(balance.denom);
      const price = prices.get(balance.denom) ?? null;
      const isQor = balance.denom === "uqor";
      // Low-liquidity prices stay out of the value, like in profit and loss.
      const usable = price && !price.lowLiquidity ? price.qorPerToken : null;
      return {
        denom: balance.denom,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        amount: balance.amount,
        qorPerToken: price?.qorPerToken ?? null,
        lowLiquidity: price?.lowLiquidity === true,
        uqor: isQor ? BigInt(balance.amount) : tokenValueUqor(balance.amount, asset.decimals, usable),
        sendable: isSendableDenom(balance.denom),
      };
    })
    .sort(compareHoldings), [balances, prices, resolveAsset]);

  const qorBalance = BigInt(balances.find((balance) => balance.denom === "uqor" && /^\d+$/.test(balance.amount))?.amount ?? "0");
  const { totalUqor, unpriced } = portfolioTotal(rows);
  const slices = allocation(rows);
  const totalUsd = qorUsd === null ? null : Number(formatBaseAmount(totalUqor.toString(), 6, 6)) * qorUsd;
  const pricing = pnl.loading && !pnl.report;
  const lowOnQor = !loading && !error && qorBalance < ONE_QOR;

  const sendable: SendableToken[] = rows.filter((row) => row.sendable).map((row) => ({ denom: row.denom, symbol: row.symbol, name: row.name, decimals: row.decimals, balance: BigInt(row.amount) }));
  // Send renders only while the deployment switches it on; otherwise it says why it is paused.
  const sendState: true | string | null = !features.actions.send ? null
    : walletNetwork.check === "wrong" ? `Switch QoreX to ${networkLabel} to send.`
    : loading && !balances.length ? "Reading your balances…"
    : error && !balances.length ? "Balances could not be read. Refresh to try again."
    : !sendable.length ? "Nothing to send yet."
    : true;

  const totals = pnl.report && pnl.report.swapsCounted > 0 ? pnl.report.totals : null;
  const pnlChange = totals ? formatPnlPercent(totals.unrealizedPnlPercent) : null;
  const shortAddress = address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "";
  const symbolOf = (denom: string) => rows.find((row) => row.denom === denom)?.symbol ?? resolveAsset(denom).symbol;
  const refreshing = loading || transactionsLoading || positionsLoading || pnl.loading;

  function chooseTab(next: Tab, focus = false) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
    if (focus) tabRefs.current[next]?.focus();
  }

  function onTabKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = TABS.findIndex((item) => item.id === tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      chooseTab(TABS[event.key === "Home" ? 0 : TABS.length - 1].id, true);
    } else if (step) {
      event.preventDefault();
      chooseTab(TABS[(index + step + TABS.length) % TABS.length].id, true);
    }
  }

  const counts: Partial<Record<Tab, number>> = { tokens: loading && !rows.length ? undefined : rows.length, pools: positions?.length };

  return <div className="app-shell">
    <QwakkHeader page="profile" onConnected={(walletAddress) => { setAddress(walletAddress); loadAll(walletAddress); }} />
    <main className="app-main">
      <div className="container portfolio">
        {!address ? <section className="pf-connect">
          <span className="empty-icon"><Wallet size={18} /></span>
          <h1>Your portfolio lives here</h1>
          <p>Connect QoreX to see balances, pool shares and every move this wallet makes. Only your public address is shared.</p>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => window.dispatchEvent(new Event("qwakk:request-connect"))}>Connect wallet</button>
        </section> : <>
          <section className="pf-hero" aria-labelledby="pf-title">
            <div className="pf-id">
              <Identicon address={address} size={44} />
              <div className="pf-id-text">
                <h1 id="pf-title">Portfolio</h1>
                <span className="pf-id-meta">
                  <button type="button" className="pf-address" onClick={() => void copier.copy(address)} title={address} aria-label={copier.state === "done" ? "Address copied" : `Copy address ${address}`}>
                    <span className="mono">{shortAddress}</span>
                    {copier.state === "done" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  </button>
                  <span className="sr-only" aria-live="polite">{copier.state === "done" ? "Copied" : ""}</span>
                  {copier.state === "done" && <span className="pf-copied" aria-hidden="true">Copied</span>}
                  {isTestnet && <span className="testnet-tag">TESTNET</span>}
                </span>
              </div>
              <button type="button" className={`icon-btn icon-btn-keep pf-refresh${refreshing ? " is-busy" : ""}`} aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => { loadAll(address); pnl.reload(); }}>
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="pf-worth">
              <span className="pf-worth-label" id="pf-worth-label">Estimated value</span>
              {loading && !balances.length ? <span className="pf-skel-value" aria-hidden="true" />
                : error && !balances.length ? <span className="pf-worth-value is-muted">Not available</span>
                : <output className="pf-worth-value num" aria-labelledby="pf-worth-label">{formatQor(totalUqor.toString())}<span className="pf-worth-unit">QOR</span></output>}
              <span className="pf-worth-sub">
                {totalUsd !== null && totalUqor > BigInt(0) && <span className="num">About {formatUsdCompact(totalUsd)}</span>}
                <span>{pricing ? "Adding up token prices…"
                  : unpriced > 0 ? `QOR plus tokens with a pool price. ${unpriced === 1 ? "1 token has" : `${unpriced} tokens have`} no price yet.`
                  : "QOR plus every token at its pool price."}</span>
              </span>
              {slices.length > 0 && <div className="pf-mix">
                <span className="pf-mix-bar" role="img" aria-label={`Split: ${slices.map((slice) => `${slice.key === "other" ? "Other" : symbolOf(slice.key)} ${formatBps(slice.bps)}`).join(", ")}`}>
                  {slices.map((slice, index) => <i key={slice.key} className={SLICE_CLASSES[Math.min(index, 3)]} style={{ flexGrow: Math.max(slice.bps, 60) }} />)}
                </span>
                <ul className="pf-mix-legend" aria-hidden="true">
                  {slices.map((slice, index) => <li key={slice.key}><i className={SLICE_CLASSES[Math.min(index, 3)]} />{slice.key === "other" ? "Other" : symbolOf(slice.key)}<span className="num">{formatBps(slice.bps)}</span></li>)}
                </ul>
              </div>}
              {totals && <button type="button" className="pf-pnl" onClick={() => chooseTab("pnl")}>
                <span className="pf-pnl-item">
                  <span>On what you hold</span>
                  <b className={`num ${pnlTone(totals.unrealizedPnlUqor) === "flat" ? "" : pnlTone(totals.unrealizedPnlUqor)}`}>{formatSignedQor(totals.unrealizedPnlUqor)} QOR</b>
                  {pnlChange && <span className={`change-pill${pnlChange.tone === "flat" ? "" : ` is-${pnlChange.tone}`}`}>{pnlChange.arrow && <span aria-hidden="true">{pnlChange.arrow}&nbsp;</span>}{pnlChange.word && <span className="sr-only">{pnlChange.word} </span>}{pnlChange.text}</span>}
                </span>
                <span className="pf-pnl-item">
                  <span>From sales</span>
                  <b className={`num ${pnlTone(totals.realizedPnlUqor) === "flat" ? "" : pnlTone(totals.realizedPnlUqor)}`}>{formatSignedQor(totals.realizedPnlUqor)} QOR</b>
                </span>
              </button>}
            </div>

            <div className="pf-actions">
              {sendState !== null && <button type="button" className="pf-action is-primary" disabled={sendState !== true} aria-describedby={sendState !== true ? "pf-send-note" : undefined} onClick={() => setSheet({ kind: "send", denom: null })}>
                <span className="pf-action-icon"><Send size={18} aria-hidden="true" /></span>Send
              </button>}
              <button type="button" className="pf-action" onClick={() => setSheet({ kind: "receive" })}>
                <span className="pf-action-icon"><ArrowDownLeft size={18} aria-hidden="true" /></span>Receive
              </button>
              <Link className="pf-action" href="/swap">
                <span className="pf-action-icon"><ArrowLeftRight size={18} aria-hidden="true" /></span>Swap
              </Link>
            </div>
            {typeof sendState === "string" && <p className="pf-action-note" id="pf-send-note">{sendState}</p>}
          </section>

          {lowOnQor && <FaucetHint lead="Low on QOR: every swap, transfer and pool move pays its network fee in QOR." className="pf-faucet" />}

          <div className="pf-tabs" role="tablist" aria-label="Portfolio sections">
            {TABS.map((item) => <button key={item.id} ref={(element) => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`pf-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`pf-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={onTabKey} onClick={() => chooseTab(item.id)}>
              {item.label}{counts[item.id] !== undefined && <span className="pf-tab-count num">{counts[item.id]}</span>}
            </button>)}
          </div>

          <div className="pf-tabpanel" role="tabpanel" id={`pf-panel-${tab}`} aria-labelledby={`pf-tab-${tab}`} key={tab}>
            {tab === "tokens" && <TokensPanel rows={rows} loading={loading} error={error} qorUsd={qorUsd} sendEnabled={sendState}
              onSend={(denom) => setSheet({ kind: "send", denom })} onReceive={() => setSheet({ kind: "receive" })} onRetry={() => void loadBalances(address)} />}
            {tab === "pools" && <>
              <PoolsPanel positions={positions} loading={positionsLoading} resolve={resolveAsset} onRetry={() => void loadPositions(address)} />
              {/* Renders only while LP rewards are switched on. */}
              <RewardsPortfolio address={address} />
            </>}
            {tab === "activity" && <ActivityPanel items={transactions} loading={transactionsLoading} error={transactionsError} resolve={resolveAsset} onRetry={() => void loadTransactions(address)} />}
            {tab === "pnl" && <ProfitLoss pnl={pnl} bare />}
          </div>
        </>}
      </div>
    </main>
    {address && sheet?.kind === "receive" && <ReceiveSheet address={address} onClose={() => setSheet(null)} />}
    {address && sheet?.kind === "send" && features.actions.send && <SendSheet key={address} address={address} tokens={sendable} initialDenom={sheet.denom} qorBalance={qorBalance} walletNetwork={walletNetwork} onClose={() => setSheet(null)} />}
    <SiteFooter />
  </div>;
}
