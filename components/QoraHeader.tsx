"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, BookOpen, Compass, House, Layers, Search, Wallet } from "lucide-react";
import { BRAND } from "../lib/brand";
import { QORECHAIN_DIANA } from "../lib/qorex-native";
import { BrandMark } from "./BrandMark";
import { LiveTicker } from "./LiveTicker";

type Page = "home" | "swap" | "pools" | "profile";

const NAV_ITEMS = [
  { page: "home", href: "/", label: "Home", icon: House },
  { page: "swap", href: "/swap", label: "Trade", icon: ArrowLeftRight },
  { page: "pools", href: "/pools", label: "Pools", icon: Layers },
  { page: "profile", href: "/profile", label: "Portfolio", icon: Wallet },
] as const;

const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";

/** The pools list listens for this event so typing in the top bar filters it in place. */
export const SEARCH_EVENT = "qora:search";

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

export function QoraHeader({ onConnected, page = "home" }: { onConnected?: (address: string) => void; page?: Page }) {
  const router = useRouter();
  const searchInput = useRef<HTMLInputElement>(null);
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

  // Other components ask the header to connect, so there is one connect flow.
  useEffect(() => {
    const requestConnect = () => void connectWallet();
    window.addEventListener("qora:request-connect", requestConnect);
    return () => window.removeEventListener("qora:request-connect", requestConnect);
  });

  // Cmd+K or Ctrl+K focuses search from anywhere.
  useEffect(() => {
    if (page === "pools" && searchInput.current) searchInput.current.value = new URLSearchParams(window.location.search).get("q") ?? "";
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [page]);

  async function connectWallet() {
    if (walletAddress) {
      if (page !== "profile") router.push("/profile");
      return;
    }
    const nativeWallet = window.qorex?.native;
    if (!nativeWallet) {
      setNeedsQoreX(true);
      setNotice(`Install QoreX to connect a QoreChain wallet, then come back to ${BRAND.name}.`);
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
      setNotice("Wallet connected. Your portfolio is ready.");
    } catch (error) {
      setNotice(walletConnectionMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  function search(value: string) {
    if (page === "pools") window.dispatchEvent(new CustomEvent(SEARCH_EVENT, { detail: value }));
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = searchInput.current?.value.trim() ?? "";
    if (page === "pools") return search(value);
    router.push(value ? `/pools?q=${encodeURIComponent(value)}` : "/pools");
  }

  const walletLabel = walletAddress ? `${walletAddress.slice(0, 7)}…${walletAddress.slice(-4)}` : isConnecting ? "Connecting…" : "Connect wallet";

  return <>
    <nav className="rail" aria-label="Primary navigation">
      <Link className="rail-brand" href="/" aria-label={`${BRAND.name} home`}><BrandMark size={34} /></Link>
      <div className="rail-links">
        {NAV_ITEMS.map(({ page: itemPage, href, label, icon: Icon }) => <Link key={itemPage} className={`rail-link ${page === itemPage ? "is-active" : ""}`} href={href} aria-current={page === itemPage ? "page" : undefined}>
          <span className="rail-icon"><Icon size={19} strokeWidth={2} /></span>
          <span className="rail-label">{label}</span>
        </Link>)}
      </div>
      <div className="rail-foot">
        <a className="rail-link" href="https://docs.qorechain.io/" target="_blank" rel="noreferrer"><span className="rail-icon"><BookOpen size={17} /></span><span className="rail-label">Docs</span></a>
        <a className="rail-link" href="https://explore.qore.network/" target="_blank" rel="noreferrer"><span className="rail-icon"><Compass size={17} /></span><span className="rail-label">Explorer</span></a>
      </div>
    </nav>
    <header className="topbar">
      <div className="topbar-inner">
        <Link className="brand topbar-brand" href="/" aria-label={`${BRAND.name} home`}><BrandMark size={28} /><span>{BRAND.name}</span></Link>
        <form className="top-search" role="search" action="/pools" onSubmit={submitSearch}>
          <Search size={15} aria-hidden="true" />
          <input ref={searchInput} name="q" type="search" placeholder="Search pools and tokens" aria-label="Search pools and tokens" autoComplete="off" onChange={(event) => search(event.target.value.trim())} />
          <kbd>⌘K</kbd>
        </form>
        <div className="topbar-actions">
          <span className="network-pill"><i className="live-dot" aria-hidden="true" />QoreChain Diana</span>
          <button type="button" className={`btn btn-sm ${walletAddress ? "btn-ghost" : "btn-primary"}`} onClick={() => void connectWallet()} disabled={isConnecting}>{walletAddress && <Wallet size={14} />}{walletLabel}</button>
        </div>
      </div>
      <LiveTicker />
    </header>
    {notice && <div className="toast" role="status"><span>{notice}</span>{needsQoreX && <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Install QoreX ↗</a>}<button type="button" onClick={() => { setNotice(""); setNeedsQoreX(false); }} aria-label="Dismiss notice">×</button></div>}
  </>;
}
