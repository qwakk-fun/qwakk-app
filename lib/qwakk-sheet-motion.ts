/**
 * Drag physics shared by the bottom sheets (components/QoreXMobileSheet.tsx,
 * components/SearchDialog.tsx), so every sheet follows the finger and settles
 * the same way.
 */

/** A dragged sheet dismisses when its projected resting point passes this share of its height. */
export const DISMISS_SHARE = 0.4;
/** The exit normally ends on transitionend; this is the backstop (hidden tab, no transition). */
export const EXIT_FALLBACK_MS = 450;
/** Initial slope of the exit curve below, used to match the sheet's speed to the finger's. */
export const EXIT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
export const EXIT_EASE_SLOPE = 4;

/** Where a flick comes to rest, given its velocity in px/ms (UIScrollView-style deceleration). */
export function projectedTravel(velocity: number, rate = 0.998) {
  return (velocity * rate) / (1 - rate);
}

/** Progressive resistance past an edge: the further the drag, the less the sheet follows. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** How long the sheet takes to travel the `remaining` px off screen at the finger's speed, clamped so it never snaps or drags. */
export function exitDuration(remaining: number, velocity: number) {
  return Math.min(400, Math.max(160, velocity > 0 ? (EXIT_EASE_SLOPE * remaining) / velocity : 360));
}
