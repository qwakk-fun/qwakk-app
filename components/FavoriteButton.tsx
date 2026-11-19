"use client";

import type { MouseEvent } from "react";
import { Star } from "lucide-react";
import type { Favorites } from "./useFavorites";

/**
 * The star that adds a pool to favorites. Pass the page's `useFavorites()`
 * so a list of stars shares one read. It sits beside a pool link, never inside
 * one, and stops the click so a card or row behind it does not open.
 */
export function FavoriteButton({ favorites, poolId, pair, className = "" }: { favorites: Favorites; poolId: string | number; pair: string; className?: string }) {
  const on = favorites.has(poolId);
  function toggle(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    favorites.toggle(poolId);
  }
  // One fixed name; aria-pressed says whether it is on, so the state is never announced twice.
  return <button type="button" className={`fav-btn ${on ? "is-on" : ""} ${className}`.trim()} aria-pressed={on} aria-label={`Add ${pair} to favorites`} disabled={!favorites.ready} onClick={toggle}>
    <Star size={18} strokeWidth={2} fill={on ? "currentColor" : "none"} aria-hidden="true" />
  </button>;
}
