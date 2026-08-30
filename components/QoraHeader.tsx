"use client";

import { useEffect, useState } from "react";
import { QORECHAIN_DIANA } from "../lib/qorex-native";

const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";

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

export function QoraHeader({ onConnected, page = "home" }: { onConnected?: (address: string) => void; page?: "home" | "swap" | "pools" | "profile" }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsQoreX, setNeedsQoreX] = useState(false);

  useEffect(() => {
    const restoreWallet = () => setWalletAddress(window.localStorage.getItem("qora-wallet-address") ?? "");
    restoreWallet();
    window.addEventListener("qora:wallet-change", restoreWallet);
    return () => window.removeEventListener("qora:wallet-change", restoreWallet);
  }, []);

  async function connectWallet() {
    if (walletAddress) {
      if (page !== "profile") window.location.assign("/profile");
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
      await nativeWallet.enable(QORECHAIN_DIANA);
      const key = await nativeWallet.getKey(QORECHAIN_DIANA);
      window.localStorage.setItem("qora-wallet-address", key.bech32Address);
      window.dispatchEvent(new Event("qora:wallet-change"));
      setWalletAddress(key.bech32Address);
      onConnected?.(key.bech32Address);
      setNotice("Wallet connected. Your Qora profile is ready.");
    } catch (error) {
      setNotice(walletConnectionMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  const walletLabel = walletAddress ? `${walletAddress.slice(0, 7)}…${walletAddress.slice(-4)}` : isConnecting ? "Connecting…" : "Connect wallet";

  return <>
    <nav className="nav" aria-label="Primary navigation">
      <a className="brand" href="/" aria-label="Qora home"><img className="brand-mark" src="/qora-mark.png" alt="" /><span>QORA</span></a>
      <div className="nav-links" aria-label="Sections"><a className={page === "swap" ? "active" : ""} href="/swap">Swap</a><a className={page === "pools" ? "active" : ""} href="/pools">Pools</a><a className={page === "profile" ? "active" : ""} href="/profile">Profile</a></div>
      <button className="wallet-button" onClick={() => void connectWallet()} disabled={isConnecting}>{walletLabel}</button>
    </nav>
    {notice && <div className="notice" role="status"><span>{notice}</span>{needsQoreX && <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Install QoreX ↗</a>}<button onClick={() => { setNotice(""); setNeedsQoreX(false); }} aria-label="Dismiss notice">×</button></div>}
  </>;
}
