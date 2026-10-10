/**
 * The Qwakk duck. The ring is both the duck's head and a "Q", and the beak is
 * the Q's tail. public/brand-mark.svg mirrors it on a dark tile for the favicon.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M26 13.5c-1.5-5-8-6.5-10.5-3 3.5-.5 6.5.8 8 3.6z" fill="#FFD43B" />
    <circle cx="28" cy="34" r="16.5" fill="none" stroke="#FFD43B" strokeWidth="10" />
    <path d="M37.5 42.5c7-3.6 16-3.8 23 .2-3.2 7.8-14.5 11-22.6 7.2z" fill="#FF8A3D" />
    <circle cx="31.5" cy="29.5" r="3.8" fill="#FFD43B" />
  </svg>;
}
