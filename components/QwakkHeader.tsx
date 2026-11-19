"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, BookOpen, Compass, House, Layers, LogOut, Plus, Search, Trophy, Wallet } from "lucide-react";
import { BRAND } from "../lib/brand";
import { CONSENT_EVENT, hasConsent } from "../lib/legal";
import { quack } from "../lib/quack";
import { POINTS_NAV_LABEL } from "../lib/qwakk-points-copy";
import { readQoreXSigner } from "../lib/qorex-native";
import { NETWORK_UNKNOWN_COPY, QOREX_PENDING_COPY, qorexNetworkCopy, type CopyNetwork } from "../lib/qwakk-tx-copy";
import { currentMobilePlatform, type MobilePlatform } from "../lib/qwakk-mobile-wallet";
import { storeWalletAddress } from "../lib/qwakk-wallet-session";
import { BrandMark } from "./BrandMark";
import { LiveTicker } from "./LiveTicker";
import { QoreXMobileSheet } from "./QoreXMobileSheet";
import { SearchDialog } from "./SearchDialog";
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

/** Opens the pool creation form when the pools page is already showing. */
export const CREATE_EVENT = "qwakk:request-create";

function walletConnectionMessage(error: unknown, network: CopyNetwork) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("lock") || message.includes("unlock") || message.includes("vault")) {
    // Inside the QoreX app's dApp browser there is no toolbar to point at.
    return currentMobilePlatform()
      ? "QoreX is locked. Unlock it in the QoreX app, then try again."
      : "QoreX is locked. Open the QoreX extension from your browser toolbar, unlock it, then try again.";
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
  const { address: walletAddress, disconnect } = useWalletSession();
  const [isConnecting, setIsConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsQoreX, setNeedsQoreX] = useState(false);
  // Set when a phone browser without QoreX asks to connect.
  const [mobileWallet, setMobileWallet] = useState<MobilePlatform | null>(null);
  const closeMobileWallet = useCallback(() => setMobileWallet(null), []);
  const { actions, points, network } = useFeatures();
  const [quacking, setQuacking] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  // "⌘K" on Apple devices, "Ctrl K" elsewhere. Read after mount so the server render stays the same.
  const [shortcut, setShortcut] = useState("⌘K");

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

  // Cmd+K or Ctrl+K opens search from anywhere.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (!/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)) setShortcut("Ctrl K"); }, 0);
    const openSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", openSearch); };
  }, []);

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
      // QoreX has no mobile extension. The QoreX app's dApp browser injects
      // window.qorex, so it never gets here; a plain phone browser does.
      const platform = currentMobilePlatform();
      if (platform) {
        setNotice("");
        setNeedsQoreX(false);
        setMobileWallet(platform);
        return;
      }
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
        {/* Looks like a field, opens the search dialog. Phones get the icon button in the actions instead. */}
        <button type="button" className="top-search" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onClick={() => setSearchOpen(true)}>
          <Search size={16} aria-hidden="true" />
          <span className="top-search-label">Search tokens, pools or paste an address</span>
          <kbd aria-hidden="true">{shortcut}</kbd>
        </button>
        <div className="topbar-actions">
          <button type="button" className="icon-btn top-search-icon" aria-haspopup="dialog" aria-label="Search tokens and pools" onClick={() => setSearchOpen(true)}><Search size={18} aria-hidden="true" /></button>
          {/* The TESTNET tag shows only on the testnet preset, and is all that stays on narrow screens. */}
          {network && <span className={`network-pill ${network.id === "testnet" ? "is-testnet" : ""}`}><i className="live-dot" aria-hidden="true" /><span className="network-pill-label">{network.label}</span>{network.id === "testnet" && <span className="testnet-tag">TESTNET</span>}</span>}
          {actions.create_pool && <Link className="icon-btn" href="/pools?create=1" aria-label="Create a pool" onClick={openCreate}><Plus size={18} /></Link>}
          <button type="button" className={`btn ${walletAddress ? "btn-ghost" : "btn-primary"}`} onClick={() => void connectWallet()} disabled={isConnecting}>{walletAddress && <Wallet size={15} />}{walletLabel}</button>
          {walletAddress && <button type="button" className="icon-btn icon-btn-keep" onClick={disconnectWallet} aria-label="Disconnect wallet" title="Disconnect wallet"><LogOut size={16} /></button>}
        </div>
      </div>
      <LiveTicker />
    </header>
    {notice && <div className="toast" role="status"><span>{notice}</span>{needsQoreX && <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Install QoreX</a>}<button type="button" onClick={() => { setNotice(""); setNeedsQoreX(false); }} aria-label="Dismiss notice">×</button></div>}
    {mobileWallet && <QoreXMobileSheet platform={mobileWallet} onClose={closeMobileWallet} />}
    {searchOpen && <SearchDialog onClose={closeSearch} />}
  </>;
}
