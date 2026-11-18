"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Copy, X } from "lucide-react";
import { BRAND } from "../lib/brand";
import { pageAddressForQoreX, qorexStoreLinks, type MobilePlatform } from "../lib/qwakk-mobile-wallet";
import { useFeatures } from "./useFeatures";

/** A dragged sheet dismisses when its projected resting point passes this share of its height. */
const DISMISS_SHARE = 0.4;
/** The exit normally ends on transitionend; this is the backstop (hidden tab, no transition). */
const EXIT_FALLBACK_MS = 450;
/** Initial slope of the exit curve below, used to match the sheet's speed to the finger's. */
const EXIT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EXIT_EASE_SLOPE = 4;

/** Where a flick comes to rest, given its velocity in px/ms (UIScrollView-style deceleration). */
function projectedTravel(velocity: number, rate = 0.998) {
  return (velocity * rate) / (1 - rate);
}

/** Progressive resistance past an edge: the further the drag, the less the sheet follows. */
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

type Drag = { id: number; startY: number; lastY: number; lastT: number; velocity: number };

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
      const duration = Math.min(400, Math.max(160, velocity > 0 ? (EXIT_EASE_SLOPE * remaining) / velocity : 360));
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
