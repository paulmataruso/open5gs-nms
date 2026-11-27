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
 * input or link inside the row), so pressing Enter on a row's own Delete button
 * does not ALSO run the row's action.
 *
 * That guard covers the KEYBOARD path only, and the distinction is load-bearing
 * for a call site. This is an onKeyDown handler, so it never sees a click --
 * and Enter on a <button> additionally makes the browser synthesise one, which
 * bubbles to the row's own onClick. So a nested control must still call
 * `e.stopPropagation()` in its own onClick, or a plain mouse click on it runs
 * the row's action too. `CallDebugCard.tsx` is the one site in the app with
 * nested controls and it does exactly that on both its <a> and its <button>.
 * Pinned by useKeyboardA11y.test.tsx, which asserts both halves separately.
 * (An earlier version of this comment described the protected action as
 * "clicking", i.e. named the one path the guard does not cover.)
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
 * see the keypress).
 *
 * `capture: true` does NOT shield a nested overlay's parent, and an earlier
 * version of this comment claimed it did ("the innermost handler runs first and
 * stops the event there"). Measured, and it fails twice over: every call site
 * attaches to the SAME node (document), so the capture phase does not order
 * them inner-first -- listeners on one node fire in REGISTRATION order, and an
 * inner overlay mounts second, so it runs LAST -- and `stopPropagation()` does
 * not stop other listeners on the same node anyway, only
 * `stopImmediatePropagation()` does. One Escape therefore closes BOTH.
 *
 * Not a live bug: no two of the 35 call sites can be open at once today. But
 * CLAUDE.md requires this hook for every new overlay, so the first genuinely
 * nested pair will dismiss its parent as well. Left as-is deliberately rather
 * than "fixed" in passing, because changing it alters dismissal for all 35
 * sites. Pinned by useKeyboardA11y.test.tsx so the behaviour is at least known
 * and cannot change unnoticed.
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
