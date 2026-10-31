"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandMark } from "./BrandMark";
import { BRAND } from "../lib/brand";
import { CONSENT_EVENT, LEGAL_PAGES, hasConsent, saveConsent } from "../lib/legal";
import { useFeatures } from "./useFeatures";

/**
 * First-visit dialog: the visitor confirms the key risks and accepts the
 * Terms, Privacy Policy and Risk Disclosure before using the app. It stays
 * off the legal pages themselves so they can always be read.
 */
export function ConsentGate() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const checkbox = useRef<HTMLInputElement>(null);
  const { network } = useFeatures();
  const onLegalPage = LEGAL_PAGES.some((page) => pathname === page.href);

  useEffect(() => {
    const timer = window.setTimeout(() => { if (!hasConsent()) setOpen(true); }, 0);
    const request = () => setOpen(true);
    window.addEventListener(CONSENT_EVENT, request);
    return () => { window.clearTimeout(timer); window.removeEventListener(CONSENT_EVENT, request); };
  }, []);

  const visible = open && !onLegalPage;

  useEffect(() => {
    if (!visible) return;
    checkbox.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [visible]);

  if (!visible) return null;

  function accept() {
    saveConsent();
    setOpen(false);
  }

  return <div className="consent-backdrop">
    <div className="consent" role="dialog" aria-modal="true" aria-labelledby="consent-title" aria-describedby="consent-points">
      <BrandMark size={56} />
      <h2 id="consent-title">Before you dive in</h2>
      <ul id="consent-points" className="consent-points">
        <li><b>{BRAND.name} never holds your funds.</b> It is an interface to the QoreChain native AMM. Every transaction is signed in your own wallet and cannot be reversed.</li>
        <li><b>Crypto is risky.</b> Token prices can drop to zero, pools can be thin and anyone can open a pool. A token&apos;s name or symbol does not prove who issued it.</li>
        {network?.id === "testnet" && <li><b>This is a test network.</b> Tokens on {network.label} are for testing only and have no value.</li>}
        <li><b>Nothing here is financial advice.</b> Trending lists and rankings are automated.</li>
      </ul>
      <label className="consent-check">
        <input ref={checkbox} type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>I am 18 or older, I am not in a sanctioned or restricted region, and I agree to the {LEGAL_PAGES.map((page, index) => <span key={page.href}>{index === LEGAL_PAGES.length - 1 ? " and " : index ? ", " : ""}<a href={page.href} target="_blank" rel="noreferrer">{page.label}</a></span>)}.</span>
      </label>
      <button type="button" className="btn btn-primary btn-block" disabled={!agreed} onClick={accept}>I understand, let me in</button>
    </div>
  </div>;
}
