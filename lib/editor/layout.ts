/**
 * How the review screen decides what kind of device it is on.
 *
 * Input and layout are separate questions (see #158). Width decides layout;
 * the pointer decides input affordances. A tablet in landscape with a
 * trackpad is a desktop, and a phone is a phone whatever it is plugged into.
 *
 * The same queries are written as the `compact` and `roomy` Tailwind variants
 * in app/globals.css, so CSS can fold the chrome before hydration and scripts
 * can make the same decision afterwards. Change one, change both.
 */

/** A coarse primary pointer: a finger, not a cursor. */
export const COARSE_POINTER = "(pointer: coarse)"

/**
 * Phones, and touch tablets in portrait: the bottom action bar replaces the
 * desktop toolbar, and panels become sheets.
 */
export const COMPACT_LAYOUT =
  "(max-width: 47.999rem), (pointer: coarse) and (max-width: 63.999rem)"

/** Wide enough for the page rail and Hush as a rail beside the page. */
export const WIDE_LAYOUT = "(min-width: 64rem)"

/** Wide enough for the search results as a column beside the page. */
export const RESULTS_COLUMN = "(min-width: 48rem)"

/** A device that plausibly has a keyboard, for offering the shortcut sheet. */
export const FINE_HOVER = "(hover: hover) and (pointer: fine)"

/** The smallest touch target, in CSS pixels. */
export const MIN_TOUCH_TARGET = 44
