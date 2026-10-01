"use client";

import { useEffect, useState } from "react";

/** Wallet actions render only after the server confirms they are switched on. */
export function useFeatures() {
  const [nativeActions, setNativeActions] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/features", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ nativeActions?: boolean }> : null)
      .then((data) => { if (active) setNativeActions(Boolean(data?.nativeActions)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return { nativeActions };
}
