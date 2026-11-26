"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Copies text to the clipboard. `state` is "done" for two seconds after a
 * copy, or "blocked" when the browser refused clipboard access (the caller
 * then shows the text for a long press instead).
 */
export function useCopy() {
  const [state, setState] = useState<"idle" | "done" | "blocked">("idle");

  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("blocked");
    }
  }, []);

  return { state, copy };
}
