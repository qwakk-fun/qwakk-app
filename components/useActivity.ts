"use client";

import { useEffect, useState } from "react";
import { formatBaseAmount } from "../lib/qora-assets";

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

/** Recent swaps across QoreChain Diana pools, refreshed on an interval and after confirmed actions. */
export function useActivity(refreshMs = 12_000): ActivityState {
  const [result, setResult] = useState<ActivityState>({ trades: [], state: "loading" });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/activity", { cache: "no-store" });
        if (!response.ok) throw new Error("Activity unavailable");
        const data = await response.json() as { swaps?: Trade[] };
        if (active) setResult({ trades: Array.isArray(data.swaps) ? data.swaps : [], state: "ready" });
      } catch {
        if (active) setResult((current) => current.state === "ready" ? current : { trades: [], state: "unavailable" });
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    const reloadSoon = () => window.setTimeout(() => void load(), 6_000);
    window.addEventListener("qora:tx-confirmed", reloadSoon);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("qora:tx-confirmed", reloadSoon); };
  }, [refreshMs]);

  return result;
}

function decimalsFor(trade: Trade, denom: string) {
  return denom === trade.token_a ? trade.token_a_decimals : denom === trade.token_b ? trade.token_b_decimals : 0;
}

function symbolFor(trade: Trade, denom: string) {
  return denom === trade.token_a ? trade.token_a_symbol : denom === trade.token_b ? trade.token_b_symbol : denom.replace(/^u/, "").toUpperCase();
}

/** A swap read from the pool's base token: receiving token A is a buy, paying it is a sell. */
export function describeTrade(trade: Trade) {
  const side: "buy" | "sell" = trade.denom_out === trade.token_a ? "buy" : "sell";
  const base = side === "buy" ? { denom: trade.denom_out, amount: trade.amount_out } : { denom: trade.denom_in, amount: trade.amount_in };
  return {
    side,
    baseAmount: formatBaseAmount(base.amount, decimalsFor(trade, base.denom), 4),
    baseSymbol: symbolFor(trade, base.denom),
    paid: `${formatBaseAmount(trade.amount_in, decimalsFor(trade, trade.denom_in), 4)} ${symbolFor(trade, trade.denom_in)}`,
    received: `${formatBaseAmount(trade.amount_out, decimalsFor(trade, trade.denom_out), 4)} ${symbolFor(trade, trade.denom_out)}`,
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
