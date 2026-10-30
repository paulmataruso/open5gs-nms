import { useEffect, useState } from 'react';

/**
 * The widest viewport that gets the mobile shell, in CSS pixels.
 *
 * This MUST stay one pixel below Tailwind's `md` breakpoint. Layout differences
 * that are purely visual are expressed as `md:` variants in the markup, and
 * only the navigation is swapped in JS (see docs/mobile-ui.md) — so if these
 * two numbers drift apart there is a band of widths that gets the mobile
 * navigation with desktop spacing, or the reverse. The symptom is a layout
 * that is subtly wrong at exactly one window size, which is about as hard to
 * notice as a bug gets.
 *
 * `scripts/check-breakpoints.mjs` asserts this against tailwind.config.js's
 * `screens.md` and runs as the first step of `npm run build` (so also inside
 * the Docker image build) — a drift fails the deploy rather than shipping.
 * There is no frontend test runner; that script is the enforcement.
 */
export const MOBILE_MAX_WIDTH_PX = 767;

const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH_PX}px)`;

/**
 * True while the viewport is narrow enough for the mobile shell.
 *
 * Width only — deliberately NOT `pointer: coarse`. Gating on touch capability
 * would mean the mobile layout could not be reached by narrowing a desktop
 * window, which is how it is developed and tested, and it would hand a
 * touchscreen laptop the phone layout at 1440px. Width is also what the
 * Tailwind breakpoints key off, so the CSS and the JS agree by construction.
 *
 * Subscribed rather than sampled: a phone rotating from portrait to landscape
 * crosses this boundary (a modern handset is ~844px wide in landscape), and a
 * read-once implementation would leave the wrong shell on screen until
 * something else happened to re-render. Layout keeps the page in one keyed
 * <main> across the swap precisely so that this crossing does not remount it.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    // Guard for a non-browser environment (tests, any future SSR) rather than
    // assuming `window` — throwing here would take the whole app down.
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);

    // Re-read on mount as well as on change: the first render's value was
    // computed before this effect ran, and in a resize-during-mount case
    // (rotating while the app loads) it can already be stale.
    setIsMobile(mql.matches);

    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);

    // Safari below 14 has no addEventListener on MediaQueryList and only the
    // deprecated addListener. Feature-detect rather than version-sniff; the
    // fallback is two lines and the alternative is a hard crash on an older
    // iPhone, which is exactly the device this feature exists for.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isMobile;
}
