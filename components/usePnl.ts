"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parsePnlReport, pnlErrorKind, type PnlErrorKind, type PnlReport } from "../lib/qwakk-pnl-display";

export type PnlState = {
  /** The wallet these figures belong to. */
  address: string;
  /** The last good report for this address, kept while a refresh runs. */
  report: PnlReport | null;
  loading: boolean;
  error: PnlErrorKind | null;
};

/** The indexer can trail the chain by a few blocks, so a confirmed swap is read again once it has caught up. */
// The indexer syncs every 5 s and can lag on catch-up, so a late pass clears stale "unknown buy price" notes.
const AFTER_TX_DELAYS_MS = [2_000, 8_000, 20_000];

/**
 * Profit and loss of one wallet from `/api/pnl`. Reloads after the wallet's
 * own confirmed transactions; a newer request always wins over an older one,
 * and a new address never shows the previous wallet's figures.
 */
export function usePnl(address: string) {
  const [state, setState] = useState<PnlState>({ address, report: null, loading: Boolean(address), error: null });
  const requestRef = useRef(0);

  const load = useCallback(async (walletAddress: string) => {
    const request = ++requestRef.current;
    if (!walletAddress) {
      setState({ address: walletAddress, report: null, loading: false, error: null });
      return;
    }
    setState((current) => ({ address: walletAddress, report: current.address === walletAddress ? current.report : null, loading: true, error: null }));
    let status: number | null = null;
    try {
      const response = await fetch(`/api/pnl?address=${encodeURIComponent(walletAddress)}`, { cache: "no-store" });
      status = response.status;
      if (!response.ok) throw new Error("unavailable");
      const report = parsePnlReport(await response.json());
      if (!report) throw new Error("unreadable");
      if (request === requestRef.current) setState({ address: walletAddress, report, loading: false, error: null });
    } catch {
      if (request === requestRef.current) setState((current) => ({ ...current, loading: false, error: pnlErrorKind(status === 200 ? null : status) }));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(address), 0);
    const pending = new Set<number>();
    const reloadAfterTx = () => {
      for (const delay of AFTER_TX_DELAYS_MS) {
        const id = window.setTimeout(() => { pending.delete(id); void load(address); }, delay);
        pending.add(id);
      }
    };
    window.addEventListener("qwakk:tx-confirmed", reloadAfterTx);
    return () => {
      window.clearTimeout(timer);
      pending.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("qwakk:tx-confirmed", reloadAfterTx);
    };
  }, [address, load]);

  const reload = useCallback(() => void load(address), [address, load]);
  // Until the new wallet's first read starts, never show the previous wallet's figures.
  if (state.address !== address) return { address, report: null, loading: Boolean(address), error: null, reload };
  return { ...state, reload };
}
