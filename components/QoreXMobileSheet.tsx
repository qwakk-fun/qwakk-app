"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { BRAND } from "../lib/brand";
import { pageAddressForQoreX, qorexStoreLinks, type MobilePlatform } from "../lib/qwakk-mobile-wallet";
import { useFeatures } from "./useFeatures";

/**
 * Shown when a phone browser asks to connect and has no `window.qorex`. QoreX
 * has no mobile extension, so the visitor opens this page in the QoreX app's
 * dApp browser, where connecting works like on desktop. No deep link is
 * offered: none that opens a URL in the dApp browser is documented
 * (see lib/qwakk-mobile-wallet.ts).
 */
export function QoreXMobileSheet({ platform, onClose }: { platform: MobilePlatform; onClose: () => void }) {
  const { network } = useFeatures();
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const field = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Read after mount so the server render never needs `window`.
    const timer = window.setTimeout(() => setAddress(pageAddressForQoreX(window.location)), 0);
    // Return focus to whatever opened the sheet (usually Connect wallet) when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", closeOnEscape);
      opener?.focus();
    };
  }, [onClose]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("done");
    } catch {
      // Clipboard access can be blocked; select the text so a long press copies it.
      field.current?.focus();
      field.current?.select();
      // iOS Safari often ignores select() on a read-only field.
      field.current?.setSelectionRange(0, field.current.value.length);
      setCopied("manual");
    }
  }

  return <div className="sheet-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sheet qorex-sheet" role="dialog" aria-modal="true" aria-labelledby="qorex-sheet-title" aria-describedby="qorex-sheet-lead">
      <div className="sheet-head">
        <h2 id="qorex-sheet-title">Your wallet lives in the QoreX app</h2>
        <button ref={closeButton} type="button" className="icon-btn icon-btn-keep" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <p id="qorex-sheet-lead" className="sheet-lead">Phone browsers can&apos;t run the QoreX extension. Open {BRAND.name} inside the QoreX app and connect from there.</p>
      <ol className="qorex-steps">
        <li>
          <span>Get the QoreX app.</span>
          <span className="qorex-stores">{qorexStoreLinks(platform).map((store) => <a key={store.id} className="btn btn-ghost btn-sm" href={store.href} target="_blank" rel="noreferrer">{store.label}</a>)}</span>
        </li>
        <li><span>In QoreX, open the <b>dApp browser</b> from the Home tab.</span></li>
        {network?.id === "testnet" && <li><span>Trading on {network.label}? In QoreX Settings, turn on <b>Use testnet (developers)</b>.</span></li>}
        <li>
          <span>Paste this address, then tap Connect wallet.</span>
          <input ref={field} className="qorex-address" type="text" readOnly value={address} aria-label={`${BRAND.name} address`} onFocus={(event) => event.currentTarget.select()} />
        </li>
      </ol>
      <button type="button" className="btn btn-primary btn-block" onClick={() => void copyAddress()} disabled={!address}>
        {copied === "done" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copied === "done" ? "Copied. Over to QoreX" : "Copy link"}
      </button>
      {copied === "manual" && <p className="sheet-note" role="status">Copying is blocked here. Press and hold the address to copy it.</p>}
    </div>
  </div>;
}
