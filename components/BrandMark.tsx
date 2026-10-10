import { useId } from "react";

/**
 * The product mark: a core with two swap arcs moving around it. It carries no
 * letter, so it survives a rename. public/brand-mark.svg mirrors it for the favicon.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  const gradient = useId();
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#a7f3c4" />
        <stop offset="1" stopColor="#4ade80" />
      </linearGradient>
    </defs>
    <rect width="32" height="32" rx="9" fill={`url(#${gradient})`} />
    <g fill="none" stroke="#052e16" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.48 13.26A8 8 0 0 1 23.52 13.26" />
      <path d="M24.63 9.88L23.52 13.26L20.49 11.38" />
      <path d="M23.52 18.74A8 8 0 0 1 8.48 18.74" />
      <path d="M7.37 22.12L8.48 18.74L11.51 20.62" />
    </g>
    <circle cx="16" cy="16" r="2.6" fill="#052e16" />
  </svg>;
}
