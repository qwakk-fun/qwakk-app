"use client";

import { Check, Copy } from "lucide-react";
import { BottomSheet } from "./BottomSheet";
import { Identicon } from "./Identicon";
import { useNetworkCopy } from "./NetworkContext";
import { useCopy } from "./useCopy";

/** The wallet's full address to share, with one copy button. */
export function ReceiveSheet({ address, onClose }: { address: string; onClose: () => void }) {
  const { label, isTestnet } = useNetworkCopy();
  const { state, copy } = useCopy();
  return <BottomSheet title="Receive" titleId="receive-sheet-title" className="receive-sheet" onClose={onClose}>
    <>
      <p className="sheet-lead">Share this address to get tokens on {label}. It is the same qor1 address QoreX shows.</p>
      <div className="receive-card">
        <Identicon address={address} size={40} />
        <output className="receive-address" aria-label="Your wallet address">{address}</output>
      </div>
      <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => void copy(address)}>
        {state === "done" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        <span aria-live="polite">{state === "done" ? "Copied" : "Copy address"}</span>
      </button>
      {state === "blocked" && <p className="sheet-note" role="status">Copying is blocked here. Press and hold the address to copy it.</p>}
      {isTestnet && <p className="sheet-note">Balances here are {label} test tokens. Anything sent on another network will not show up here.</p>}
    </>
  </BottomSheet>;
}
