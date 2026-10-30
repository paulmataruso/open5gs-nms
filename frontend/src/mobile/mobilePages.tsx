import { lazy, Suspense } from 'react';
import { MLoading } from './MobileKit';
import { NeedsDesktopPage } from './NeedsDesktopPage';
import { isMobilePageId, type MobilePageId } from './mobileNav';

/**
 * The mobile site's page table.
 *
 * Lazily imported, exactly like the desktop pages in App.tsx — a static import
 * here would pull all nine mobile pages (and every API client they touch) into
 * the initial bundle, which is the specific regression route splitting was
 * introduced to fix, and it would land on the device least able to absorb it.
 *
 * Typed as a TOTAL record over MobilePageId, so adding an id to
 * MOBILE_PAGE_IDS without building its page is a compile error rather than a
 * destination that renders blank at runtime.
 */

const MobileDashboardPage = lazy(() => import('./MobileDashboardPage').then(m => ({ default: m.MobileDashboardPage })));
const MobileRanPage = lazy(() => import('./MobileRanPage').then(m => ({ default: m.MobileRanPage })));
const MobileServicesPage = lazy(() => import('./MobileServicesPage').then(m => ({ default: m.MobileServicesPage })));
const MobileSubscribersPage = lazy(() => import('./MobileSubscribersPage').then(m => ({ default: m.MobileSubscribersPage })));
const MobileLogsPage = lazy(() => import('./MobileLogsPage').then(m => ({ default: m.MobileLogsPage })));
const MobileUeSignalPage = lazy(() => import('./MobileUeSignalPage').then(m => ({ default: m.MobileUeSignalPage })));
const MobileTrafficHistoryPage = lazy(() => import('./MobileTrafficHistoryPage').then(m => ({ default: m.MobileTrafficHistoryPage })));
const MobileSasPage = lazy(() => import('./MobileSasPage').then(m => ({ default: m.MobileSasPage })));
const MobileCallHistoryPage = lazy(() => import('./MobileCallHistoryPage').then(m => ({ default: m.MobileCallHistoryPage })));

/** Every mobile page gets the navigate callback, whether or not it links out. */
type MobilePageProps = { onNavigate: (tab: string) => void };

const MOBILE_PAGES: Record<MobilePageId, (p: MobilePageProps) => JSX.Element> = {
  'dashboard': ({ onNavigate }) => <MobileDashboardPage onNavigate={onNavigate} />,
  'ran': () => <MobileRanPage />,
  'services': () => <MobileServicesPage />,
  'subscribers': () => <MobileSubscribersPage />,
  'logs': () => <MobileLogsPage />,
  'radio-signal': () => <MobileUeSignalPage />,
  'traffic-history': () => <MobileTrafficHistoryPage />,
  'sas': () => <MobileSasPage />,
  'cdr': () => <MobileCallHistoryPage />,
};

/**
 * Renders the mobile page for a tab id, or the needs-a-desktop screen.
 *
 * The Suspense boundary is here rather than around the whole shell so that a
 * page's own chunk loading never blanks the chrome — the top bar and tab bar
 * stay on screen and interactive while the page arrives, which on a slow
 * mobile connection is the difference between "loading" and "broken".
 */
export function MobilePage(
  { tabId, onNavigate }: { tabId: string; onNavigate: (tab: string) => void },
): JSX.Element {
  const render = isMobilePageId(tabId) ? MOBILE_PAGES[tabId] : null;
  return (
    <Suspense fallback={<div className="px-4 pt-3"><MLoading /></div>}>
      {render
        ? render({ onNavigate })
        : <NeedsDesktopPage tabId={tabId} onNavigate={onNavigate} />}
    </Suspense>
  );
}
