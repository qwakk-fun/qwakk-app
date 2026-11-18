"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CHART_INTERVALS, CHART_INTERVAL_LABELS, type ChartInterval } from "../lib/qwakk-chart";

/**
 * Candle interval picker: a segmented control whose lifted thumb slides to
 * the chosen interval on the shared spring (a cross-fade under reduced
 * motion, see globals.css). The thumb is measured from the pressed button, so
 * it lines up at any width and font size.
 */
export function ChartIntervalTabs({ value, onChange }: { value: ChartInterval; onChange: (next: ChartInterval) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      const active = element.querySelector<HTMLButtonElement>("button[aria-pressed='true']");
      if (active) setThumb({ x: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  return <div ref={track} className={`segmented interval-tabs ${thumb ? "has-thumb" : ""}`} role="group" aria-label="Chart interval"
    style={thumb ? { "--thumb-x": `${thumb.x}px`, "--thumb-w": `${thumb.width}px` } as CSSProperties : undefined}>
    <span className="segmented-thumb" aria-hidden="true" />
    {CHART_INTERVALS.map((option) => <button type="button" key={option} aria-pressed={option === value} title={CHART_INTERVAL_LABELS[option]} onClick={() => onChange(option)}>{option}</button>)}
  </div>;
}
