"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, BookOpen, Compass, House, Layers, LogOut, Plus, Search, Trophy, Wallet } from "lucide-react";
import { BRAND } from "../lib/brand";
import { CONSENT_EVENT, hasConsent } from "../lib/legal";
import { quack } from "../lib/quack";
import { POINTS_NAV_LABEL } from "../lib/qwakk-points-copy";
import { readQoreXSigner } from "../lib/qorex-native";
import { NETWORK_UNKNOWN_COPY, QOREX_PENDING_COPY, qorexNetworkCopy, type CopyNetwork } from "../lib/qwakk-tx-copy";
import { storeWalletAddress } from "../lib/qwakk-wallet-session";
import { BrandMark } from "./BrandMark";
import { LiveTicker } from "./LiveTicker";
import { loadFeatures, useFeatures } from "./useFeatures";
import { useWalletSession } from "./useWalletSession";

type Page = "home" | "swap" | "pools" | "points" | "profile" | "fees" | "legal" | "vault";

const NAV_ITEMS = [
  { page: "home", href: "/", label: "Board", icon: House },
  { page: "swap", href: "/swap", label: "Trade", icon: ArrowLeftRight },
  { page: "pools", href: "/pools", label: "Pools", icon: Layers },
  // Shown only while the points program is switched on.
  { page: "points", href: "/points", label: POINTS_NAV_LABEL, icon: Trophy },
  { page: "profile", href: "/profile", label: "Portfolio", icon: Wallet },
] as const;

const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";

/** The pools list listens for this event so typing in the top bar filters it in place. */
export const SEARCH_EVENT = "qwakk:search";
/** Opens the pool creation form when the pools page is already showing. */
export const CREATE_EVENT = "qwakk:request-create";

function walletConnectionMessage(error: unknown, network: CopyNetwork) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("lock") || message.includes("unlock") || message.includes("vault")) {
    return "QoreX is locked. Open the QoreX extension from your browser toolbar, unlock it, then try again.";
  }
  if (message.includes("active network") || message.includes("unsupported chain")) return qorexNetworkCopy(network);
  if (message.includes("reject") || message.includes("denied")) {
    return "Wallet connection was not approved. Try again whenever you are ready.";
  }
  if (message.includes("already waiting") || message.includes("requests are waiting")) return QOREX_PENDING_COPY;
  return "QoreX could not complete the connection. Make sure it is unlocked, then try again.";
}

export function QwakkHeader({ onConnected, page = "home" }: { onConnected?: (address: string) => void; page?: Page }) {
  const router = useRouter();
  const searchInput = useRef<HTMLInputElement>(null);
  const { address: walletAddress, disconnect } = useWalletSession();
  const [isConnecting, setIsConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsQoreX, setNeedsQoreX] = useState(false);
  const { actions, points, network } = useFeatures();
  const [quacking, setQuacking] = useState(false);

  // Easter egg: the duck says "wak wak" and shakes its head.
  function quackLogo() {
    quack();
    setQuacking(true);
    window.setTimeout(() => setQuacking(false), 520);
  }

  // Other components ask the header to connect, so there is one connect flow.
  useEffect(() => {
    const requestConnect = () => void connectWallet();
    window.addEventListener("qwakk:request-connect", requestConnect);
    return () => window.removeEventListener("qwakk:request-connect", requestConnect);
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
    // The terms and risk notice must be accepted before any wallet connects.
    if (!hasConsent()) {
      window.dispatchEvent(new Event(CONSENT_EVENT));
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
      // QoreX is asked for the server's configured network, never a constant.
      const target = (await loadFeatures())?.network;
      if (!target) {
        setNotice(NETWORK_UNKNOWN_COPY);
        return;
      }
      try {
        // One call: getKey connects the site if needed and never opens a window while QoreX is locked.
        const address = await readQoreXSigner(nativeWallet, target.chainId);
        storeWalletAddress(address);
        onConnected?.(address);
        setNotice("Wallet connected. Your portfolio is ready.");
      } catch (error) {
        setNotice(walletConnectionMessage(error, target));
      }
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnectWallet() {
    disconnect();
    setNeedsQoreX(false);
    setNotice("Wallet disconnected. QoreX still lists this site until you remove it there.");
  }

  function openCreate(event: React.MouseEvent) {
    if (page !== "pools") return;
    event.preventDefault();
    window.dispatchEvent(new Event(CREATE_EVENT));
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
      <Link className={`rail-brand ${quacking ? "is-quacking" : ""}`} href="/" aria-label={`${BRAND.name} home`} onClick={quackLogo}><BrandMark size={32} /></Link>
      <div className="rail-links">
        {NAV_ITEMS.filter((item) => item.page !== "points" || points).map(({ page: itemPage, href, label, icon: Icon }) => <Link key={itemPage} className={`rail-link ${page === itemPage ? "is-active" : ""}`} href={href} aria-current={page === itemPage ? "page" : undefined}>
          <Icon size={20} strokeWidth={2} aria-hidden="true" />
          <span className="rail-label">{label}</span>
        </Link>)}
        {actions.create_pool && <Link className="rail-create" href="/pools?create=1" aria-label="Create a pool" onClick={openCreate}><Plus size={20} strokeWidth={2.4} aria-hidden="true" /><span className="rail-label">New pool</span></Link>}
      </div>
      <div className="rail-foot">
        <a className="rail-link" href="https://docs.qorechain.io/" target="_blank" rel="noreferrer"><BookOpen size={18} aria-hidden="true" /><span className="rail-label">Docs</span></a>
        <a className="rail-link" href="https://explore.qore.network/" target="_blank" rel="noreferrer"><Compass size={18} aria-hidden="true" /><span className="rail-label">Explorer</span></a>
      </div>
    </nav>
    <header className="topbar">
      <div className="topbar-inner">
        <Link className={`brand topbar-brand ${quacking ? "is-quacking" : ""}`} href="/" aria-label={`${BRAND.name} home`} onClick={quackLogo}><BrandMark size={28} /><span>{BRAND.name}</span></Link>
        <form className="top-search" role="search" action="/pools" onSubmit={submitSearch}>
          <Search size={16} aria-hidden="true" />
          <input ref={searchInput} name="q" type="search" placeholder="Search pools and tokens" aria-label="Search pools and tokens" autoComplete="off" onChange={(event) => search(event.target.value.trim())} />
          <kbd>⌘K</kbd>
        </form>
        <div className="topbar-actions">
          {network && <span className="network-pill"><i className="live-dot" aria-hidden="true" /><span>{network.label}</span></span>}
          {actions.create_pool && <Link className="icon-btn" href="/pools?create=1" aria-label="Create a pool" onClick={openCreate}><Plus size={18} /></Link>}
          <button type="button" className={`btn ${walletAddress ? "btn-ghost" : "btn-primary"}`} onClick={() => void connectWallet()} disabled={isConnecting}>{walletAddress && <Wallet size={15} />}{walletLabel}</button>
          {walletAddress && <button type="button" className="icon-btn icon-btn-keep" onClick={disconnectWallet} aria-label="Disconnect wallet" title="Disconnect wallet"><LogOut size={16} /></button>}
        </div>
      </div>
      <LiveTicker />
    </header>
    {notice && <div className="toast" role="status"><span>{notice}</span>{needsQoreX && <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Install QoreX</a>}<button type="button" onClick={() => { setNotice(""); setNeedsQoreX(false); }} aria-label="Dismiss notice">×</button></div>}
  </>;
}
