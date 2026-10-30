import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A tab id is reflected into the URL hash, so it has to be something safe to
 * read back out of a user-controllable string. Every real id in this app is
 * lowercase-kebab; anything else is ignored rather than trusted.
 *
 * This regex is only the character-safety check. Whether a well-formed id is
 * one this build can actually show is a separate question the caller answers
 * via `isKnownTab`, because the set depends on feature flags this hook has no
 * business knowing about. Both checks are needed: App's page switch falling
 * back to the dashboard fixes what is RENDERED but leaves `activeTab` holding
 * the bogus id, so the title and every nav highlight would disagree with the
 * page.
 */
const TAB_ID = /^[a-z0-9-]{1,40}$/;

function tabFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape sequence throws; treat it as no hash at all.
    return null;
  }
  return TAB_ID.test(decoded) ? decoded : null;
}

interface HistoryState {
  nmsTab?: string;
}

/**
 * Tab state that the browser's back and forward buttons actually drive.
 *
 * This app navigates by state rather than routes, which meant the back button
 * did nothing at all. On a desktop that is a papercut; on a phone, back is the
 * primary navigation gesture, and a back button that silently does nothing
 * reads as a frozen app — which is why the UX guidance rates it High severity.
 *
 * Reflecting the tab in the hash also makes a screen linkable and survivable
 * across a reload, which it previously was not: every refresh landed you back
 * on the dashboard.
 */
export function useTabHistory(
  defaultTab: string,
  /**
   * Returns true for a tab this build can actually show. Without it an
   * unknown or feature-disabled id from the URL is kept in state: App's switch
   * falls back to the dashboard for the PAGE, but `activeTab` keeps the bogus
   * value, so the title, the sidebar highlight and the bottom bar all insist
   * the user is somewhere they are not. Newly reachable now that the tab is
   * URL-addressable.
   */
  isKnownTab?: (tab: string) => boolean,
): [string, (tab: string) => void] {
  const resolve = (tab: string | null): string =>
    tab && (!isKnownTab || isKnownTab(tab)) ? tab : defaultTab;

  const [activeTab, setActiveTab] = useState<string>(() => resolve(tabFromHash()));

  // Give the FIRST history entry a state object. Without this, the entry that
  // existed before the app mounted has `state === null`, so popping back to it
  // leaves the handler below with nothing to restore from and the UI keeps
  // whatever tab it was on — a back press that visibly does nothing, which is
  // the exact bug this hook exists to fix.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const current = (window.history.state ?? {}) as HistoryState;
    const hash = tabFromHash();
    // Only touch the URL when it is already carrying a tab (so a bad or
    // disabled one gets corrected) — otherwise seed history.state alone and
    // leave the address bar as the user found it. Writing "#dashboard" into a
    // bare URL on first paint is a visible side effect of mounting, and it
    // happens behind the login screen too.
    const needsUrlFix = hash !== null && hash !== activeTab;
    if (current.nmsTab === undefined || needsUrlFix) {
      window.history.replaceState(
        { ...current, nmsTab: activeTab },
        '',
        needsUrlFix || hash !== null ? `#${activeTab}` : window.location.href,
      );
    }
    // Mount only: this seeds the entry the app started on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = (e: PopStateEvent) => {
      const state = (e.state ?? {}) as HistoryState;
      const next = resolve(
        (state.nmsTab && TAB_ID.test(state.nmsTab) ? state.nmsTab : null)
        // Falls back to the hash for an entry this app did not create — e.g. a
        // link someone pasted, or an entry from before a deploy.
        ?? tabFromHash(),
      );
      // setState ONLY. Pushing from inside a pop handler builds a history stack
      // that grows as you try to leave it, so back can never escape the page.
      setActiveTab(next);
    };
    // A same-document fragment navigation (someone edits the address bar from
    // #dashboard to #logs and presses Enter) fires hashchange, NOT popstate —
    // so without this the URL and the UI silently disagree, and the next back
    // press "restores" the tab the user is already on.
    const onHashChange = () => {
      const fromHash = tabFromHash();
      if (!fromHash) return;
      const next = resolve(fromHash);
      setActiveTab(prev => (prev === next ? prev : next));
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHashChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTab]);

  // The current tab in a ref so `navigate` can compare against it without
  // taking it as a dependency (which would give every consumer a new callback
  // identity on each navigation).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const navigate = useCallback((tab: string) => {
    // pushState is deliberately OUTSIDE the setState updater.
    //
    // An updater must be pure, and React is free to re-invoke it — StrictMode
    // double-invokes every updater in development, which made this push TWICE
    // per tap: both invocations saw the same `prev`, so a `prev === tab` guard
    // inside could not suppress the second. Back then needed two presses per
    // navigation in dev and one in production, which is the worst place for a
    // navigation bug to hide.
    const next = resolve(tab);
    // Re-tapping the current tab must not stack a duplicate entry, or the user
    // has to press back as many times as they tapped to get anywhere.
    if (activeTabRef.current === next) return;
    if (typeof window !== 'undefined') {
      window.history.pushState({ nmsTab: next }, '', `#${next}`);
    }
    activeTabRef.current = next;
    setActiveTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [activeTab, navigate];
}
