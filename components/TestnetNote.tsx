"use client";

import { testnetTransactionCopy } from "../lib/qwakk-tx-copy";
import { useNetworkCopy } from "./NetworkContext";

/**
 * One compact line in a review before QoreX opens: this transaction is on the
 * testnet, with test tokens. Renders nothing on mainnet.
 */
export function TestnetNote() {
  const { network } = useNetworkCopy();
  const copy = testnetTransactionCopy(network);
  if (!copy) return null;
  return <p className="testnet-note"><span className="testnet-tag">TESTNET</span><span>{copy}</span></p>;
}
