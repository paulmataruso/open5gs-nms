import { useEffect } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Keyboard parity for elements that are clickable but are not <button>/<a>.
 *
 * A div or table row with an onClick is invisible to the keyboard: no tab stop,
 * no Enter/Space activation. Rather than restructure a lot of real layout (a
 * clickable <tr> cannot simply become a <button> without breaking the table),
 * these give the element the behaviour a button would have had.
 */

/**
 * Enter/Space activation for a non-button control. Space is preventDefault'ed
 * because its default action on a focusable non-button is to scroll the page.
 * Activation is ignored when the event came from a nested control (a button,
 * input or link inside the row), so clicking a row's own Delete button does not
 * also trigger the row.
 */
export function activateOnKey<T extends HTMLElement>(handler: () => void) {
  return (e: ReactKeyboardEvent<T>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    if (t && t !== e.currentTarget && t.closest('button, a, input, select, textarea')) return;
    if (e.key === ' ') e.preventDefault();
    handler();
  };
}

/**
 * Dismiss-on-Escape for an overlay. A backdrop that closes on click has no
 * keyboard equivalent -- and giving the backdrop itself a tab stop is worse,
 * since it puts a focusable element with no accessible name in the tab order.
 * Escape is the expected keyboard gesture, so that is what this provides.
 *
 * Bound on document rather than the overlay so it works regardless of where
 * focus currently sits (an overlay that never took focus would otherwise never
 * see the keypress). `capture` keeps a nested overlay from closing its parent
 * as well -- the innermost handler runs first and stops the event there.
 */
export function useEscapeKey(onEscape: (() => void) | undefined, active = true) {
  useEffect(() => {
    if (!active || !onEscape) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape, active]);
}
