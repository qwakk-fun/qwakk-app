"use client";

import { Droplets } from "lucide-react";
import { useNetworkCopy } from "./NetworkContext";
import { QORECHAIN_FAUCET_URL, faucetAmountsText } from "../lib/qwakk-faucet";

/**
 * Points an unfunded tester at the official QoreChain faucet. Renders on the
 * testnet only: there is no mainnet faucet.
 */
export function FaucetHint({ lead = "Short on test tokens?", className = "" }: { lead?: string; className?: string }) {
  const { isTestnet } = useNetworkCopy();
  if (!isTestnet) return null;
  return <p className={`faucet-hint ${className}`}>
    <Droplets size={14} aria-hidden="true" />
    <span>{lead} The <a href={QORECHAIN_FAUCET_URL} target="_blank" rel="noreferrer">QoreChain faucet</a> pays {faucetAmountsText()} once every 24 hours (QoreChain Dashboard sign-in required).</span>
  </p>;
}
