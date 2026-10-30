import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { MoreHorizontal } from 'lucide-react';
import { NmsLogoMark } from './NmsLogo';
import { UserMenu } from './UserMenu';
import { MobileNavSheet } from './MobileNavSheet';
import { mobilePrimaryTabs, navLabelFor, MOBILE_PRIMARY_TAB_IDS } from './navItems';

/**
 * The phone chrome: a title bar above the page and a tab bar below it.
 *
 * These are two separate components rather than one wrapper around `children`
 * ON PURPOSE. `Layout` renders a single root element for both shells and keeps
 * the page inside one keyed `<main>`, so switching between mobile and desktop
 * does not change the element type at the page's position. If the shell were a
 * wrapper component, crossing 768px would swap the root element type and React
 * would unmount the entire page subtree — losing a running install's streamed
 * log, a half-typed subscriber form, an open modal and any in-flight wizard
 * state. A phone rotating to landscape is ~844px wide, so that boundary gets
 * crossed by an ordinary gesture, not an edge case.
 */

export function MobileTopBar({ activeTab }: { activeTab: string }): JSX.Element {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-nms-border bg-nms-surface px-3">
      <NmsLogoMark size={28} />
      {/* A <p>, not an <h1>: every page already renders its own <h1>, and the
          layout convention is one per page. Two would make heading navigation
          announce the same words twice in a row. */}
      <p className="min-w-0 flex-1 truncate font-display text-base font-semibold text-nms-text">
        {navLabelFor(activeTab)}
      </p>
      <UserMenu collapsed variant="topbar" />
    </header>
  );
}

export function MobileTabBar(
  { activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void },
): JSX.Element {
  // A custom property set on the <nav> only cascades to the nav's own
  // descendants — a `position: fixed` toolbar elsewhere in the tree would
  // never see it. Publishing on <html> for the lifetime of the mobile bar is
  // what makes `var(--nms-bottom-chrome)` resolve for those consumers, and
  // removing it on unmount is what makes the desktop shell fall back to 0.
  useEffect(() => {
    document.documentElement.style.setProperty('--nms-bottom-chrome', '3.5rem');
    return () => { document.documentElement.style.removeProperty('--nms-bottom-chrome'); };
  }, []);

  const [sheetOpen, setSheetOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  const primary = mobilePrimaryTabs();
  // "More" highlights whenever the open page is not one of the four in the bar.
  // Without this the bar shows nothing selected on most destinations, which
  // reads as broken rather than deliberate.
  const onPrimary = (MOBILE_PRIMARY_TAB_IDS as readonly string[]).includes(activeTab);

  // Stable identity so useEscapeKey inside the sheet does not tear down and
  // re-add its document listener on every render.
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  // Android's hardware back (and the browser's back) must DISMISS the sheet,
  // not navigate the page behind it.
  //
  // Without this, a back press while the sheet is open fires the app's own
  // popstate handler: the tab changes, the title and highlights move, and the
  // sheet stays open — so the user's dismissal gesture silently performed a
  // navigation instead. That is worse than the no-op back button this whole
  // layer set out to fix, because something does happen and it is the wrong
  // thing.
  //
  // Opening pushes a marker entry so there is something for back to pop, and
  // closing by any other route (Escape, the X, picking a destination) pops it
  // back off so the entry does not linger and make the NEXT back press a
  // no-op. `popped` guards against calling history.back() in response to the
  // pop we are already handling.
  const openSheet = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.history.pushState({ ...(window.history.state ?? {}), nmsSheet: true }, '');
    }
    setSheetOpen(true);
  }, []);

  useEffect(() => {
    if (!sheetOpen || typeof window === 'undefined') return;
    let popped = false;
    const onPop = () => { popped = true; setSheetOpen(false); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed without a back press, so retire the marker entry we pushed.
      if (!popped && (window.history.state as { nmsSheet?: boolean } | null)?.nmsSheet) {
        window.history.back();
      }
    };
  }, [sheetOpen]);

  return (
    <>
      {/*
        relative z-50 is load-bearing: the shell root is a plain div and so not
        a stacking context, which means any `position: fixed` element elsewhere
        in the app paints over this bar in the root stacking context. The
        Subscribers bulk-action toolbar (fixed bottom-6 z-40) did exactly that,
        covering the nav while rows were selected. Floating bars also offset
        themselves by --nms-bottom-chrome, declared here so there is one source
        for the bar's height.
      */}
      <nav
        aria-label="Primary"
        className="relative z-50 grid shrink-0 border-t border-nms-border bg-nms-surface"
        style={{
          gridTemplateColumns: `repeat(${primary.length + 1}, minmax(0, 1fr))`,
        }}
      >
        {primary.map(item => {
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                // min-h-14 (56px) clears the 44px comfort target and the 24px
                // WCAG floor, with the label inside the target, not beside it.
                'flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 transition-colors',
                // active: not hover: — hover never fires on touch, and the UA
                // tap highlight is suppressed app-wide, so without this a tap
                // produces no feedback at all.
                active ? 'text-nms-accent' : 'text-nms-text-dim',
                'active:bg-nms-surface-2',
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {/* shortLabel, because five columns on a 320px screen leave ~56px
                  of content width and the full labels clip there. */}
              <span className="w-full truncate text-center text-[11px] font-medium leading-tight">
                {item.shortLabel ?? item.label}
              </span>
            </button>
          );
        })}

        <button
          ref={moreRef}
          type="button"
          onClick={openSheet}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          className={clsx(
            'flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 transition-colors',
            !onPrimary ? 'text-nms-accent' : 'text-nms-text-dim',
            'active:bg-nms-surface-2',
          )}
        >
          <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span className="w-full truncate text-center text-[11px] font-medium leading-tight">More</span>
        </button>
      </nav>

      {sheetOpen && (
        <MobileNavSheet
          activeTab={activeTab}
          onNavigate={onTabChange}
          onClose={closeSheet}
          returnFocusTo={moreRef}
        />
      )}
    </>
  );
}
