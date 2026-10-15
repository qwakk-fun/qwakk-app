"use client";

import { useEffect, useState } from "react";

/** Points are rescored every 5 minutes; reading every minute keeps the page close without load. */
export const POINTS_REFRESH_MS = 60_000;

export type PointsResult<T> = { kind: "ok"; data: T } | { kind: "invalid" } | { kind: "unavailable" };

/**
 * Reads a points route. Only the outcome comes back, never the route's or
 * the browser's error text: 400 is an invalid address, anything else that is
 * not a 200 with JSON is "unavailable" (503, a switched off flag, a network
 * error or a bad body).
 */
export async function fetchPoints<T>(url: string, signal?: AbortSignal): Promise<PointsResult<T>> {
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    if (response.status === 400) return { kind: "invalid" };
    if (!response.ok) return { kind: "unavailable" };
    const data = await response.json() as T | null;
    return data && typeof data === "object" ? { kind: "ok", data } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The wallet connected through the header, kept in step with connect and disconnect. */
export function useConnectedWallet() {
  const [address, setAddress] = useState("");
  useEffect(() => {
    const restore = () => setAddress((window.localStorage.getItem("qwakk-wallet-address") ?? "").trim().toLowerCase());
    restore();
    window.addEventListener("qwakk:wallet-change", restore);
    return () => window.removeEventListener("qwakk:wallet-change", restore);
  }, []);
  return address;
}

/** The current time on a steady beat, for "updated X min ago". Zero until mounted. */
export function usePointsClock(stepMs = 30_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [stepMs]);
  return now;
}
