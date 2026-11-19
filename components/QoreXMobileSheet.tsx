"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { BRAND } from "../lib/brand";
import { pageAddressForQoreX, qorexBrowseLink, qorexStoreLinks, type MobilePlatform } from "../lib/qwakk-mobile-wallet";
import { DISMISS_SHARE, EXIT_EASE, EXIT_FALLBACK_MS, exitDuration, projectedTravel, rubberband } from "../lib/qwakk-sheet-motion";
import { useFeatures } from "./useFeatures";

type Drag = { id: number; startY: number; lastY: number; lastT: number; velocity: number };

/**
 * Shown when a phone browser asks to connect and has no `window.qorex`. QoreX
 * has no mobile extension, so the visitor opens this page in the QoreX app's
 * dApp browser, where connecting works like on desktop. The primary action is
 * QoreX's browse link (lib/qwakk-mobile-wallet.ts); it is a plain link in the
 * same tab because iOS and Android hand a link to the app only when the user
 * taps it. Store links and copy and paste stay as the fallback.
 */
export function QoreXMobileSheet({ platform, onClose }: { platform: MobilePlatform; onClose: () => void }) {
  const { network } = useFeatures();
  const [address, setAddress] = useState("");
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  // Null until the address is read after mount, and on a non-https page.
  const browseLink = address ? qorexBrowseLink(address) : null;
  const field = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // Closing plays the exit (the way it came in) before the parent unmounts the sheet.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
  }, []);

  useEffect(() => {
    if (!closing) return;
    const element = sheet.current;
    let done = false;
    const finish = () => { if (!done) { done = true; onClose(); } };
    const onEnd = (event: TransitionEvent) => { if (event.target === element && (event.propertyName === "transform" || event.propertyName === "opacity")) finish(); };
    element?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    return () => { element?.removeEventListener("transitionend", onEnd); window.clearTimeout(timer); };
  }, [closing, onClose]);

  useEffect(() => {
    // Read after mount so the server render never needs `window`.
    const timer = window.setTimeout(() => setAddress(pageAddressForQoreX(window.location)), 0);
    // Return focus to whatever opened the sheet (usually Connect wallet) when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") requestClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", closeOnEscape);
      opener?.focus();
    };
  }, [requestClose]);

  // Phones only: the grabber and title row drag the sheet 1:1 with the finger.
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const element = sheet.current;
    const target = event.target as HTMLElement;
    if (!element || closingRef.current || !event.isPrimary || event.button !== 0) return;
    if (!target.closest(".sheet-grabber, .sheet-head") || target.closest("button, a, input")) return;
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    // Grabbed mid-entrance: carry on from where the sheet is on screen, not where it was heading.
    const current = new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;
    element.style.animation = "none";
    element.style.transition = "none";
    element.style.transform = `translateY(${current}px)`;
    element.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startY: event.clientY - current, lastY: event.clientY, lastT: event.timeStamp, velocity: 0 };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const element = sheet.current;
    if (!state || !element || event.pointerId !== state.id) return;
    const elapsed = event.timeStamp - state.lastT;
    if (elapsed > 0) state.velocity = 0.8 * ((event.clientY - state.lastY) / elapsed) + 0.2 * state.velocity;
    state.lastY = event.clientY;
    state.lastT = event.timeStamp;
    const offset = event.clientY - state.startY;
    // Down follows the finger; up resists, since the sheet is already fully open.
    const y = offset >= 0 ? offset : -rubberband(-offset, element.offsetHeight);
    element.style.transform = `translateY(${y}px)`;
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const element = sheet.current;
    if (!state || !element || event.pointerId !== state.id) return;
    drag.current = null;
    const offset = Math.max(0, event.clientY - state.startY);
    // A finger that paused before lifting has no momentum left.
    const velocity = event.type === "pointercancel" || event.timeStamp - state.lastT > 80 ? 0 : state.velocity;
    const height = element.offsetHeight;
    if (event.type !== "pointercancel" && offset + projectedTravel(velocity) > height * DISMISS_SHARE) {
      // Leave at the finger's speed: the exit curve starts EXIT_EASE_SLOPE times faster than its average.
      const remaining = height + 24 - offset;
      const duration = exitDuration(remaining, velocity);
      element.style.transition = `transform ${Math.round(duration)}ms ${EXIT_EASE}`;
      element.style.transform = `translateY(${height + 24}px)`;
      requestClose();
      return;
    }
    // Settle back: the stylesheet's spring takes over from the current position.
    element.style.transition = "";
    element.style.transform = "";
  }

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

  return <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <div ref={sheet} className="sheet qorex-sheet" role="dialog" aria-modal="true" aria-labelledby="qorex-sheet-title" aria-describedby="qorex-sheet-lead" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <span className="sheet-grabber" aria-hidden="true" />
      <div className="sheet-head">
        <h2 id="qorex-sheet-title">Your wallet lives in the QoreX app</h2>
        <button ref={closeButton} type="button" className="icon-btn icon-btn-keep" onClick={requestClose} aria-label="Close"><X size={18} /></button>
      </div>
      <p id="qorex-sheet-lead" className="sheet-lead">Phone browsers can&apos;t run the QoreX extension. The QoreX app has its own browser: {BRAND.name} runs there and connects to your wallet.</p>
      {browseLink && <a className="btn btn-primary btn-block" href={browseLink}><ExternalLink size={16} aria-hidden="true" />Open in QoreX</a>}
      {network?.id === "testnet" && <p className="sheet-note">Trading on {network.label}? In QoreX Settings, turn on <b>Use testnet (developers)</b> before you connect.</p>}
      <ol className="qorex-steps">
        <li>
          <span>No QoreX app yet? Install it, then come back to this page.</span>
          <span className="qorex-stores">{qorexStoreLinks(platform).map((store) => <a key={store.id} className="btn btn-ghost btn-sm" href={store.href} target="_blank" rel="noreferrer">{store.label}</a>)}</span>
        </li>
        <li>
          <span>{browseLink ? "Link didn't open the app? " : ""}In QoreX, open the <b>dApp browser</b> from the Home tab, paste this address, then tap Connect wallet.</span>
          <input ref={field} className="qorex-address" type="text" readOnly value={address} aria-label={`${BRAND.name} address`} onFocus={(event) => event.currentTarget.select()} />
        </li>
      </ol>
      <button type="button" className={`btn ${browseLink ? "btn-ghost" : "btn-primary"} btn-block`} onClick={() => void copyAddress()} disabled={!address}>
        {copied === "done" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {copied === "done" ? "Copied. Over to QoreX" : "Copy address"}
      </button>
      {copied === "manual" && <p className="sheet-note" role="status">Copying is blocked here. Press and hold the address to copy it.</p>}
    </div>
  </div>;
}
