import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Search, X } from 'lucide-react';
import { NAV_ITEMS, type NavItem } from './navItems';
import { isMobilePageId } from '../../mobile/mobileNav';
import { useEscapeKey } from '../../hooks/useKeyboardA11y';

interface MobileNavSheetProps {
  activeTab: string;
  onNavigate: (tab: string) => void;
  onClose: () => void;
  /** Focus goes back here on close — normally the "More" button that opened it. */
  returnFocusTo?: React.RefObject<HTMLElement>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The full destination list on a phone, in two groups.
 *
 * It has a search field because there are 19 unconditional destinations plus up
 * to 18 more behind feature flags: a list that long is not navigable by
 * scrolling, and the bottom bar can only surface four.
 *
 * The split between "mobile" and "needs a desktop" is deliberately VISIBLE
 * rather than a filter. Hiding the desktop-only destinations would be tidier
 * and worse: several modules here can genuinely be switched off at build time,
 * so an absent entry is indistinguishable from a disabled feature, and an
 * operator would be left wondering which. Showing them, marked, and still
 * tappable — they land on the needs-a-desktop screen, which explains itself —
 * is the only arrangement that never reads as a bug.
 */
export function MobileNavSheet(
  { activeTab, onNavigate, onClose, returnFocusTo }: MobileNavSheetProps,
): JSX.Element {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEscapeKey(onClose);

  // Focus the field on open so the first keystroke filters. A timeout rather
  // than autoFocus: on iOS autoFocus can fire before the sheet has settled and
  // scroll the page under the keyboard.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Return focus to whatever opened this. Without it the focused node is
  // removed on close, focus falls to <body>, and the next Tab restarts at the
  // top of the document — so a keyboard or switch user loses their place every
  // time they pass through the nav, which is the thing you pass through to get
  // anywhere.
  useEffect(() => {
    const previouslyFocused = (document.activeElement as HTMLElement | null);
    return () => {
      const target = returnFocusTo?.current ?? previouslyFocused;
      // Only if it is still in the document — the trigger can legitimately be
      // gone if navigating changed the chrome.
      if (target && document.contains(target)) target.focus();
    };
  }, [returnFocusTo]);

  // Focus containment. aria-modal tells assistive tech that everything outside
  // is hidden; without actually confining Tab, the user walks out of the dialog
  // into controls the screen reader has just hidden and can activate them while
  // the dialog is still open. Claiming aria-modal without this is worse than
  // omitting it, so the claim and the behaviour ship together.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(n => n.offsetParent !== null || n === document.activeElement);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const { onMobile, desktopOnly, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q ? NAV_ITEMS.filter(i => i.label.toLowerCase().includes(q)) : NAV_ITEMS;
    const mob: NavItem[] = [];
    const desk: NavItem[] = [];
    for (const i of matches) (isMobilePageId(i.id) ? mob : desk).push(i);
    return { onMobile: mob, desktopOnly: desk, total: matches.length };
  }, [query]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" role="dialog" aria-modal="true" aria-label="All sections">
      {/*
        A div, not a button. The accessibility baseline is explicit that a
        backdrop which closes on click must NOT be a tab stop: it would put a
        full-screen control in the tab order, and here it would be the FIRST
        one inside the dialog, so Shift+Tab from the search field landed on an
        invisible full-screen button. Escape and the X button are the keyboard
        paths; this is the pointer path only, and aria-hidden keeps it out of
        the accessibility tree entirely.
      */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      {/* dvh, not vh: vh resolves against the largest viewport on mobile
          Safari, which is the whole reason this layer exists. */}
      <div
        ref={panelRef}
        className="relative mt-auto flex max-h-[85dvh] flex-col rounded-t-xl border-t border-nms-border bg-nms-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-nms-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-nms-text-dim" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search sections"
              aria-label="Search sections"
              // min-h-11 (44px) to match the close button beside it and the
              // rest of the mobile chrome; .nms-input alone is ~36px.
              className="nms-input min-h-11 w-full !pl-9"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-nms-text-dim hover:bg-nms-surface-2 hover:text-nms-text active:bg-nms-surface-2"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto overscroll-contain p-2" aria-label="All sections">
          {total === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-nms-text-dim">
              Nothing matches “{query}”.
            </p>
          ) : (
            <>
              {onMobile.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { onNavigate(item.id); onClose(); }}
                  aria-current={activeTab === item.id ? 'page' : undefined}
                  className={clsx(
                    'flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                    activeTab === item.id
                      ? 'border border-nms-accent/20 bg-nms-accent/10 text-nms-accent'
                      : 'border border-transparent text-nms-text-dim active:bg-nms-surface-2',
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate text-left font-display">{item.label}</span>
                </button>
              ))}

              {desktopOnly.length > 0 && (
                <>
                  <h2 className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-nms-text-dim">
                    Needs a desktop
                  </h2>
                  {desktopOnly.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { onNavigate(item.id); onClose(); }}
                      aria-current={activeTab === item.id ? 'page' : undefined}
                      /* Still tappable: it opens the screen that explains why,
                         which is more useful than a disabled control that
                         cannot say anything. */
                      className={clsx(
                        'flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                        activeTab === item.id
                          ? 'border border-nms-accent/20 bg-nms-accent/10 text-nms-accent'
                          : 'border border-transparent text-nms-text-dim/60 active:bg-nms-surface-2',
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
                      <span className="flex-1 truncate text-left font-display">{item.label}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-nms-text-dim">
                        desktop
                      </span>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </nav>
      </div>
    </div>
  );
}
