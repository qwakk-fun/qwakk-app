"use client";

import { useEffect, useState } from "react";

type Features = { nativeActions: boolean; points: boolean };

/** Wallet actions and the points pages render only after the server confirms they are switched on. */
export function useFeatures() {
  const [features, setFeatures] = useState<Features>({ nativeActions: false, points: false });
  useEffect(() => {
    let active = true;
    fetch("/api/features", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ nativeActions?: boolean; points?: boolean }> : null)
      .then((data) => { if (active) setFeatures({ nativeActions: Boolean(data?.nativeActions), points: Boolean(data?.points) }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return features;
}
