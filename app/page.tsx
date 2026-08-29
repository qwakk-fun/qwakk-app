"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

const TESTNET_API = "https://api-testnet.qore.host";
const TESTNET_RPC = "https://rpc-testnet.qore.host";
type NetworkState = "connecting" | "online" | "offline";
type Pool = { id?: string | number; token_a?: { denom?: string }; token_b?: { denom?: string }; type?: string };

function shortDenom(denom?: string) {
  if (!denom) return "Unknown";
  if (denom === "uqor") return "QOR";
  return denom.replace(/^u/, "").toUpperCase();
}

export default function Home() {
  const [network, setNetwork] = useState<NetworkState>("connecting");
  const [height, setHeight] = useState<string>("—");
  const [pools, setPools] = useState<Pool[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("Checking network");
  const [amount, setAmount] = useState("1");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState("");

  const refreshNetwork = useCallback(async () => {
    setIsRefreshing(true);
    setNetwork("connecting");
    try {
      const [statusResult, poolsResult] = await Promise.all([
        fetch(`${TESTNET_RPC}/status`, { cache: "no-store" }),
        fetch(`${TESTNET_API}/qorechain/amm/v1/pools`, { cache: "no-store" }),
      ]);
      if (!statusResult.ok || !poolsResult.ok) throw new Error("Testnet unavailable");
      const statusJson = await statusResult.json();
      const poolsJson = await poolsResult.json();
      setHeight(statusJson?.result?.sync_info?.latest_block_height ?? "Live");
      setPools(Array.isArray(poolsJson?.pools) ? poolsJson.pools : []);
      setNetwork("online");
      setLastUpdated(`Updated ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
      setNetwork("offline");
      setLastUpdated("Could not reach Diana testnet");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => { void refreshNetwork(); }, [refreshNetwork]);
  function showWalletNotice(event: FormEvent) {
    event.preventDefault();
    setNotice("QoreX signing adapter is the next integration step. Network reads are live now.");
  }
  const statusText = network === "online" ? "Diana testnet online" : network === "offline" ? "Testnet unavailable" : "Connecting to Diana";

  return <main className="shell">
    <nav className="nav" aria-label="Primary navigation">
      <a className="brand" href="#swap" aria-label="Qora home"><span className="brand-mark">Q</span><span>QORA</span></a>
      <div className="nav-links" aria-label="Sections"><a className="active" href="#swap">Swap</a><a href="#pools">Pools</a><a href="#positions">Positions</a></div>
      <button className="wallet-button" onClick={() => setNotice("Connect a QoreX wallet to sign native x/amm swaps.")}>Connect wallet</button>
    </nav>

    <section className="hero" aria-labelledby="headline">
      <div><p className="eyebrow"><span className={`status-dot ${network}`} /> {statusText}</p><h1 id="headline">Simple swaps.<br /><em>Native settlement.</em></h1><p className="hero-copy">Qora is a clean trading surface for QoreChain&apos;s native <code>x/amm</code> liquidity layer.</p></div>
      <div className="network-card"><div className="network-topline"><span>NETWORK</span><span className="pill">TESTNET</span></div><strong>QoreChain Diana</strong><div className="network-stats"><div><span>Chain</span><b>qorechain-diana</b></div><div><span>Height</span><b>{height}</b></div></div><button className="text-button" onClick={() => void refreshNetwork()} disabled={isRefreshing}>{isRefreshing ? "Refreshing…" : "Refresh connection ↗"}</button></div>
    </section>

    <section className="workspace" id="swap" aria-label="Swap workspace">
      <form className="swap-card" onSubmit={showWalletNotice}>
        <div className="card-heading"><div><p className="kicker">NATIVE AMM</p><h2>Swap</h2></div><button type="button" className="settings" aria-label="Swap settings" onClick={() => setNotice("Slippage protection is enforced by x/amm's min-out guard.")}>⚙</button></div>
        <label className="amount-box"><span>You pay</span><div className="amount-row"><input aria-label="You pay amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><button type="button" className="token"><i className="token-orb qor" />QOR <span>⌄</span></button></div><small>Native denom · uqor</small></label>
        <button type="button" className="flip" aria-label="Switch swap tokens" onClick={() => setNotice("Token routing will activate when Diana testnet pools are available.")}>↓</button>
        <label className="amount-box receive-box"><span>You receive</span><div className="amount-row muted-row"><output>{pools.length ? "Quote available" : "—"}</output><button type="button" className="token"><i className="token-orb usdc" />USDC <span>⌄</span></button></div><small>{pools.length ? "Live x/amm pool quote" : "No QOR / USDC pool on Diana yet"}</small></label>
        <div className="swap-details"><span>Route <b>{pools.length ? "Native x/amm" : "Waiting for pool"}</b></span><span>Slippage <b>0.50%</b></span></div><button className="primary-button" type="submit">Connect QoreX to swap <span>→</span></button>
      </form>
      <aside className="market-card" id="pools"><div className="card-heading"><div><p className="kicker">ON-CHAIN DATA</p><h2>Testnet pools</h2></div><span className="pool-count">{pools.length}</span></div><p className="muted-copy">Directly read from the Diana <code>x/amm</code> endpoint.</p>{pools.length > 0 ? <div className="pool-list">{pools.slice(0, 4).map((pool, index) => <div className="pool-row" key={`${pool.id ?? index}`}><span className="pair-icons"><i className="token-orb qor" /><i className="token-orb alt" /></span><span><b>{shortDenom(pool.token_a?.denom)} / {shortDenom(pool.token_b?.denom)}</b><small>{pool.type?.replace("_", " ") ?? "native pool"}</small></span><span className="pool-id">#{pool.id ?? index + 1}</span></div>)}</div> : <div className="empty-state"><span className="empty-mark">+</span><h3>No pools yet</h3><p>Diana is connected. The first native pool will appear here as soon as it is created.</p><button type="button" className="outline-button" onClick={() => setNotice("Pool creation will use the native MsgCreatePool flow via QoreX.")}>Create test pool</button></div>}<p className="freshness"><span className="status-dot small online" /> {lastUpdated}</p></aside>
    </section>
    <section className="feature-strip" id="positions"><article><span>01</span><h3>Protocol-native</h3><p>Trades settle in QoreChain&apos;s built-in AMM, not an extra contract layer.</p></article><article><span>02</span><h3>Slippage aware</h3><p>Every swap is protected by a native min-out or max-in limit.</p></article><article><span>03</span><h3>Built for QoreX</h3><p>Native wallet signing is the next piece in the Qora testnet path.</p></article></section>
    {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
    <footer><span>QORA / DIANA TESTNET</span><span>Simple swaps on QoreChain</span><a href="https://docs.qorechain.io/architecture/amm" target="_blank" rel="noreferrer">Native AMM docs ↗</a></footer>
  </main>;
}
