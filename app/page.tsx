"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { QoraHeader } from "../components/QoraHeader";

type NetworkState = "connecting" | "online" | "offline";
type Pool = { id?: string | number; token_a?: { denom?: string }; token_b?: { denom?: string }; type?: string };
type QoreXNativeProvider = {
  enable: (chainId: string) => Promise<void>;
  getKey: (chainId: string) => Promise<{ bech32Address: string }>;
};

declare global {
  interface Window {
    qorex?: { native?: QoreXNativeProvider };
  }
}

const QORECHAIN_TESTNET = "qorechain-diana";
const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";

function shortDenom(denom?: string) {
  if (!denom) return "Unknown";
  if (denom === "uqor") return "QOR";
  return denom.replace(/^u/, "").toUpperCase();
}

function walletConnectionMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("lock") || message.includes("unlock") || message.includes("vault")) {
    return "QoreX is locked. Open the QoreX extension from your browser toolbar, unlock it, then try again.";
  }
  if (message.includes("reject") || message.includes("denied")) {
    return "Wallet connection was not approved. Try again whenever you are ready.";
  }
  return "QoreX could not complete the connection. Make sure it is unlocked, then try again.";
}

export default function Home() {
  const [network, setNetwork] = useState<NetworkState>("connecting");
  const [pools, setPools] = useState<Pool[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("Checking network");
  const [amount, setAmount] = useState("1");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState("");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [needsQoreX, setNeedsQoreX] = useState(false);

  const refreshNetwork = useCallback(async () => {
    setIsRefreshing(true);
    setNetwork("connecting");
    try {
      const response = await fetch("/api/network", { cache: "no-store" });
      if (!response.ok) throw new Error("Network unavailable");
      const networkJson = await response.json();
      setPools(Array.isArray(networkJson?.pools) ? networkJson.pools : []);
      setNetwork("online");
      setLastUpdated(`Updated ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
      setNetwork("offline");
      setLastUpdated("Could not reach QoreChain");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => { void refreshNetwork(); }, [refreshNetwork]);
  async function connectWallet() {
    if (walletAddress) {
      window.location.assign("/profile");
      return;
    }

    const nativeWallet = window.qorex?.native;
    if (!nativeWallet) {
      setNeedsQoreX(true);
      setNotice("Install QoreX to connect a QoreChain wallet, then come back to Qora.");
      return;
    }

    setIsConnecting(true);
    setNeedsQoreX(false);
    try {
      await nativeWallet.enable(QORECHAIN_TESTNET);
      const key = await nativeWallet.getKey(QORECHAIN_TESTNET);
      setWalletAddress(key.bech32Address);
      window.localStorage.setItem("qora-wallet-address", key.bech32Address);
      window.dispatchEvent(new Event("qora:wallet-change"));
      setNotice("Wallet connected. Your Qora profile is ready.");
    } catch (error) {
      setNotice(walletConnectionMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  function showWalletNotice(event: FormEvent) {
    event.preventDefault();
    if (!walletAddress) {
      void connectWallet();
      return;
    }
    setNotice("Your wallet is connected. Swaps will be available once pools are live.");
  }
  const statusText = "QoreChain Diana";

  return <main className="shell">
    <QoraHeader onConnected={setWalletAddress} />

    <section className="hero" aria-labelledby="headline">
      <div><p className="eyebrow"><span className={`status-dot ${network}`} /> {statusText}</p><h1 id="headline">Swap simply.<br /><em>Stay in control.</em></h1><p className="hero-copy">Fast, simple swaps on QoreChain. A clear experience from your first quote to confirmation.</p></div>
      <div className="hero-visual" aria-label="Qora brand mark">
        <div className="mark-field"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="spark spark-a" /><span className="spark spark-b" /><img src="/qora-mark.png" alt="Qora logo" className="hero-mark" /><p>QORA <i /> SIMPLE SWAPS</p></div>
      </div>
    </section>

    <section className="workspace" id="swap" aria-label="Swap workspace">
      <form className="swap-card" onSubmit={showWalletNotice}>
        <div className="card-heading"><div><p className="kicker">READY WHEN YOU ARE</p><h2>Make a swap</h2></div><button type="button" className="settings" aria-label="Swap settings" onClick={() => setNotice("Choose the price protection you are comfortable with before confirming a swap.")}>⚙</button></div>
        <label className="amount-box"><span>You send</span><div className="amount-row"><input aria-label="You send amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><button type="button" className="token"><i className="token-orb qor" />QOR <span>⌄</span></button></div><small>Choose the amount you&apos;d like to swap</small></label>
        <button type="button" className="flip" aria-label="Switch swap tokens" onClick={() => setNotice("Choose the tokens you would like to swap between.")}>↓</button>
        <label className="amount-box receive-box"><span>You receive</span><div className="amount-row muted-row"><output>{pools.length ? "Your estimate" : "—"}</output><button type="button" className="token"><i className="token-orb usdc" />USDC <span>⌄</span></button></div><small>{pools.length ? "Your estimated amount updates before you confirm" : "Select a pool to see your estimate"}</small></label>
        <div className="swap-details"><span>Price <b>{pools.length ? "Preview available" : "Available soon"}</b></span><span>Protection <b>0.50%</b></span></div><button className="primary-button" type="submit" disabled={isConnecting}>{walletAddress ? "Try swap when ready" : isConnecting ? "Connecting wallet…" : "Connect wallet to continue"} <span>→</span></button>
      </form>
      <aside className="market-card" id="pools"><div className="card-heading"><div><p className="kicker">EXPLORE</p><h2>Available pools</h2></div><span className="pool-count">{pools.length}</span></div><p className="muted-copy">Discover simple ways to swap and provide liquidity on QoreChain.</p>{pools.length > 0 ? <div className="pool-list">{pools.slice(0, 4).map((pool, index) => <div className="pool-row" key={`${pool.id ?? index}`}><span className="pair-icons"><i className="token-orb qor" /><i className="token-orb alt" /></span><span><b>{shortDenom(pool.token_a?.denom)} / {shortDenom(pool.token_b?.denom)}</b><small>{pool.type?.replace("_", " ") ?? "liquidity pool"}</small></span><span className="pool-id">#{pool.id ?? index + 1}</span></div>)}</div> : <div className="empty-state"><span className="empty-mark">+</span><h3>More swaps are on the way</h3><p>New pools will appear here as they become available. Check back soon to explore them.</p><button type="button" className="outline-button" onClick={() => setNotice("New liquidity pools will appear here as they become available.")}>Explore what&apos;s next</button></div>}<p className="freshness"><span className="status-dot small online" /> {lastUpdated}</p></aside>
    </section>
    <section className="feature-strip" id="positions"><article><span>01</span><h3>Made for simple swaps</h3><p>A clear, focused experience from your first quote to confirmation.</p></article><article><span>02</span><h3>Know before you swap</h3><p>Review your price and protection settings before you confirm.</p></article><article><span>03</span><h3>Ready for mainnet</h3><p>Qora is being shaped for the full non-custodial mainnet experience.</p></article></section>
    {notice && <div className="notice" role="status"><span>{notice}</span>{needsQoreX && <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Install QoreX ↗</a>}<button onClick={() => { setNotice(""); setNeedsQoreX(false); }} aria-label="Dismiss notice">×</button></div>}
    <footer><span>QORA / QORECHAIN</span><span>Simple swaps on QoreChain</span><a href="https://docs.qorechain.io/architecture/amm" target="_blank" rel="noreferrer">Learn about QoreChain ↗</a></footer>
  </main>;
}
