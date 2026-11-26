"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { DISMISS_SHARE, EXIT_EASE, EXIT_FALLBACK_MS, exitDuration, projectedTravel, rubberband } from "../lib/qwakk-sheet-motion";

type Drag = { id: number; startY: number; lastY: number; lastT: number; velocity: number };

const SheetClose = createContext<() => void>(() => {});

/** Closes the surrounding BottomSheet with its exit motion (ignored while it is locked). */
export function useSheetClose() {
  return useContext(SheetClose);
}

/** Tab and Shift+Tab wrap inside the sheet, and focus that escaped it comes back. */
function trapFocus(event: KeyboardEvent, sheet: HTMLElement | null) {
  if (!sheet) return;
  const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const inside = sheet.contains(document.activeElement);
  if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A modal sheet with the same look and motion as the QoreX hand-off sheet
 * (components/QoreXMobileSheet.tsx): centered on desktop, docked to the bottom
 * on phones, where the grabber and title row drag it down to dismiss. Focus
 * stays inside while it is open and returns to the opener on close. While
 * `locked` (a wallet request in flight) it cannot be dismissed.
 */
export function BottomSheet({ title, titleId, className = "", locked = false, onClose, children }: {
  title: ReactNode;
  titleId: string;
  className?: string;
  locked?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const lockedRef = useRef(locked);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => { lockedRef.current = locked; }, [locked]);

  const requestClose = useCallback(() => {
    if (closingRef.current || lockedRef.current) return;
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
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
      else if (event.key === "Tab") trapFocus(event, sheet.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
      opener?.focus({ preventScroll: true });
    };
  }, [requestClose]);

  // Phones only: the grabber and title row drag the sheet 1:1 with the finger.
  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const element = sheet.current;
    const target = event.target as HTMLElement;
    if (!element || closingRef.current || lockedRef.current || !event.isPrimary || event.button !== 0) return;
    if (!target.closest(".sheet-grabber, .sheet-head") || target.closest("button, a, input")) return;
    if (!window.matchMedia("(max-width: 760px)").matches) return;
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
    const y = offset >= 0 ? offset : -rubberband(-offset, element.offsetHeight);
    element.style.transform = `translateY(${y}px)`;
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const element = sheet.current;
    if (!state || !element || event.pointerId !== state.id) return;
    drag.current = null;
    const offset = Math.max(0, event.clientY - state.startY);
    const velocity = event.type === "pointercancel" || event.timeStamp - state.lastT > 80 ? 0 : state.velocity;
    const height = element.offsetHeight;
    if (event.type !== "pointercancel" && offset + projectedTravel(velocity) > height * DISMISS_SHARE) {
      const remaining = height + 24 - offset;
      element.style.transition = `transform ${Math.round(exitDuration(remaining, velocity))}ms ${EXIT_EASE}`;
      element.style.transform = `translateY(${height + 24}px)`;
      requestClose();
      return;
    }
    element.style.transition = "";
    element.style.transform = "";
  }

  return <div className={`sheet-backdrop${closing ? " is-closing" : ""}`} role="presentation" onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <div ref={sheet} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <span className="sheet-grabber" aria-hidden="true" />
      <div className="sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button ref={closeButton} type="button" className="icon-btn icon-btn-keep" onClick={requestClose} disabled={locked} aria-label="Close"><X size={18} /></button>
      </div>
      <SheetClose.Provider value={requestClose}>{children}</SheetClose.Provider>
    </div>
  </div>;
}
