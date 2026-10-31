"use client";

import { useEffect, useState } from "react";
import { formatTokenAmount, resolveUsableAsset } from "../lib/qwakk-asset-resolve";
import { displaySymbol, formatBaseAmount, withAssetOverrides } from "../lib/qwakk-assets";

export type Trade = {
  tx_hash: string;
  executed_at: string;
  sender: string | null;
  denom_in: string;
  amount_in: string;
  denom_out: string;
  amount_out: string;
  pool_id: string;
  token_a: string;
  token_b: string;
  token_a_symbol: string;
  token_b_symbol: string;
  token_a_decimals: number;
  token_b_decimals: number;
};

export type ActivityState = { trades: Trade[]; state: "loading" | "ready" | "unavailable" };

/** Recent swaps across the network's pools, refreshed on an interval and after confirmed actions. */
export function useActivity(refreshMs = 12_000): ActivityState {
  const [result, setResult] = useState<ActivityState>({ trades: [], state: "loading" });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/activity", { cache: "no-store" });
        if (!response.ok) throw new Error("Activity unavailable");
        const data = await response.json() as { swaps?: Trade[] };
        // Curated symbols and decimals win over the indexed token record.
        if (active) setResult({ trades: Array.isArray(data.swaps) ? data.swaps.map(withAssetOverrides) : [], state: "ready" });
      } catch {
        if (active) setResult((current) => current.state === "ready" ? current : { trades: [], state: "unavailable" });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qwakk:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qwakk:tx-confirmed", reloadSoon); };
  }, [refreshMs]);

  return result;
}

/** Display decimals, or null when unknown (shown as labeled base units, never at a guessed scale). */
function decimalsFor(trade: Trade, denom: string) {
  const decimals = denom === trade.token_a ? trade.token_a_decimals : denom === trade.token_b ? trade.token_b_decimals : undefined;
  return resolveUsableAsset(denom, undefined, { decimals }).displayDecimals;
}

function symbolFor(trade: Trade, denom: string) {
  return denom === trade.token_a ? trade.token_a_symbol : denom === trade.token_b ? trade.token_b_symbol : displaySymbol(denom);
}

/**
 * A swap read from the pool's base token: receiving the base is a buy, paying
 * it is a sell. `quoteSide` comes from the market row (`quote_side`); without
 * it token B is the quote, as the indexer does for unranked pairs.
 */
export function describeTrade(trade: Trade, quoteSide: "a" | "b" | null = null) {
  const baseDenom = quoteSide === "a" ? trade.token_b : trade.token_a;
  const side: "buy" | "sell" = trade.denom_out === baseDenom ? "buy" : "sell";
  const base = side === "buy" ? { denom: trade.denom_out, amount: trade.amount_out } : { denom: trade.denom_in, amount: trade.amount_in };
  const baseSymbol = symbolFor(trade, base.denom);
  const quote = side === "buy" ? trade.denom_in : trade.denom_out;
  return {
    side,
    /** The token the base was priced in, e.g. "QOR". */
    quoteSymbol: symbolFor(trade, quote),
    /** The traded base amount with its symbol, e.g. "1.5 fETH". */
    base: formatTokenAmount(base.amount, decimalsFor(trade, base.denom), baseSymbol, 4),
    baseSymbol,
    paid: formatTokenAmount(trade.amount_in, decimalsFor(trade, trade.denom_in), symbolFor(trade, trade.denom_in), 4),
    received: formatTokenAmount(trade.amount_out, decimalsFor(trade, trade.denom_out), symbolFor(trade, trade.denom_out), 4),
  };
}

/** The QOR side of a swap in whole QOR, or null when QOR is not part of it. */
export function tradeQorVolume(trade: Trade) {
  const amount = trade.denom_in === "uqor" ? trade.amount_in : trade.denom_out === "uqor" ? trade.amount_out : null;
  return amount === null ? null : Number(formatBaseAmount(amount, 6, 6));
}

export function shortWallet(address: string | null) {
  return address ? `${address.slice(0, 7)}…${address.slice(-4)}` : "Unknown wallet";
}

/** "12s ago", "4m ago", "3h ago" or "2d ago". */
export function timeAgo(value: string, now = Date.now()) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
