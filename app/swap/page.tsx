"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { QoraHeader } from "../../components/QoraHeader";
import { TokenIcon } from "../../components/TokenIcon";
import { displaySymbol } from "../../lib/qora-assets";

type Pool = { id?: string | number; token_a?: { denom?: string }; token_b?: { denom?: string }; type?: string };

function shortDenom(denom?: string) { return denom ? displaySymbol(denom) : "Unknown"; }

export default function SwapPage() {
  const [pools, setPools] = useState<Pool[]>([]);
  const [amount, setAmount] = useState("1");
  const [walletAddress, setWalletAddress] = useState("");
  const [notice, setNotice] = useState("");
  const [lastUpdated, setLastUpdated] = useState("Checking available markets");

  const refreshPools = useCallback(async () => {
    try {
      const response = await fetch("/api/network", { cache: "no-store" });
      if (!response.ok) throw new Error("Network unavailable");
      const data = await response.json();
      setPools(Array.isArray(data?.pools) ? data.pools : []);
      setLastUpdated(`Updated ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
      setLastUpdated("Could not reach available markets");
    }
  }, []);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qora-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qora:wallet-change", restoreWallet);
    void refreshPools();
    return () => window.removeEventListener("qora:wallet-change", restoreWallet);
  }, [refreshPools]);

  function prepareSwap(event: FormEvent) {
    event.preventDefault();
    if (!walletAddress) {
      setNotice("Connect your wallet from the header before preparing a swap.");
      return;
    }
    setNotice(pools.length ? "Choose a market to continue to your wallet review." : "There are no available markets yet. Create the first pool to make swapping possible.");
  }

  return <main className="profile-shell swap-shell">
    <QoraHeader page="swap" onConnected={setWalletAddress} />
    <section className="swap-page-hero"><p className="eyebrow">SIMPLE SWAPS ON QORECHAIN</p><h1>Swap with <em>confidence.</em></h1><p>Enter the amount you want to swap. Qora keeps the details clear before your wallet ever asks for approval.</p></section>
    <section className="swap-workspace" aria-label="Swap workspace">
      <form className="swap-card swap-card-expanded" onSubmit={prepareSwap}>
        <div className="card-heading"><div><p className="kicker">SWAP</p><h2>Choose your assets</h2></div><button type="button" className="settings" aria-label="Swap settings" onClick={() => setNotice("Price protection will be chosen before you confirm a live swap.")}>⚙</button></div>
        <label className="amount-box"><span>You send</span><div className="amount-row"><input aria-label="You send amount in QOR" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><button type="button" className="token"><TokenIcon denom="uqor" size="small" />QOR <span>⌄</span></button></div><small>Enter QOR. Qora handles the on-chain unit automatically.</small></label>
        <button type="button" className="flip" aria-label="Switch swap tokens" onClick={() => setNotice("Choose the tokens you would like to swap between.")}>↓</button>
        <label className="amount-box receive-box"><span>You receive</span><div className="amount-row muted-row"><output>{pools.length ? "Your estimate" : "Unavailable"}</output><button type="button" className="token"><TokenIcon denom="uusdc" size="small" />USDC <span>⌄</span></button></div><small>{pools.length ? "Your estimated amount updates before you confirm." : "A quote will appear when a market is available."}</small></label>
        <div className="swap-details"><span>Price <b>{pools.length ? "Preview available" : "Available soon"}</b></span><span>Protection <b>0.50%</b></span><span>Qora fee <b>0.05%</b></span></div>
        <button className="primary-button" type="submit">{walletAddress ? "Review swap" : "Connect wallet to continue"}<span>→</span></button>
      </form>
      <aside className="market-card swap-market-card"><div className="card-heading"><div><p className="kicker">AVAILABLE MARKETS</p><h2>Choose a pool</h2></div><span className="pool-count">{pools.length}</span></div><p className="muted-copy">Pools make swaps possible. Pick one when liquidity is available, or create a new market.</p>{pools.length ? <div className="pool-list">{pools.map((pool, index) => <button className="pool-row pool-choice" type="button" key={`${pool.id ?? index}`} onClick={() => setNotice(`${shortDenom(pool.token_a?.denom)} / ${shortDenom(pool.token_b?.denom)} selected. Your quote will be available before confirmation.`)}><span className="pair-icons"><TokenIcon denom={pool.token_a?.denom ?? ""} size="small" /><TokenIcon denom={pool.token_b?.denom ?? ""} size="small" /></span><span><b>{shortDenom(pool.token_a?.denom)} / {shortDenom(pool.token_b?.denom)}</b><small>{pool.type?.replace("_", " ") ?? "liquidity pool"}</small></span><span className="pool-id">#{pool.id ?? index + 1}</span></button>)}</div> : <div className="empty-state"><span className="empty-mark">+</span><h3>Start the first market</h3><p>Create a pool, set an opening price, and make the first swap possible.</p><a className="outline-button" href="/pools">Create a pool</a></div>}<p className="freshness"><span className="status-dot small online" /> {lastUpdated}</p></aside>
    </section>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
  </main>;
}
