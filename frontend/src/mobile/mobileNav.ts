import { NAV_ITEMS, type NavItem } from '../components/common/navItems';

/**
 * The destinations that have a purpose-built mobile page.
 *
 * This list is the mobile site's scope, decided deliberately rather than
 * emerging from whatever happened to reflow acceptably. These nine are the
 * things an operator does FROM a phone: find out whether anything is wrong,
 * check whether the radios and the core are up, look up one subscriber, read
 * what the core is actually saying, and see recent calls/traffic/signal.
 *
 * Everything else is a sit-down task — the 17-NF YAML editors, the Auto Config
 * wizard, RF Planning's map, Backup & Restore, the module install lifecycles.
 * Those are deliberately NOT given a phone layout. A cramped version of a
 * destructive multi-step wizard is worse than no version: it invites the
 * mistake you least want made one-thumbed, and it implies a level of support
 * that is not there. `desktopOnlyNavItems()` surfaces them in the nav sheet as
 * explicitly desktop-only, which is honest, rather than hiding them and
 * leaving the operator to wonder whether the feature is switched off.
 *
 * Adding a page here without building its mobile component is a compile error,
 * because MOBILE_PAGES in mobilePages.tsx is typed as a total record over
 * MobilePageId.
 */
export const MOBILE_PAGE_IDS = [
  'dashboard',
  'ran',
  'services',
  'subscribers',
  'logs',
  'radio-signal',
  'traffic-history',
  'sas',
  'cdr',
] as const;

export type MobilePageId = typeof MOBILE_PAGE_IDS[number];

const MOBILE_ID_SET: ReadonlySet<string> = new Set(MOBILE_PAGE_IDS);

export function isMobilePageId(id: string): id is MobilePageId {
  return MOBILE_ID_SET.has(id);
}

/**
 * The mobile destinations this build actually shows, in sidebar order.
 *
 * Filters NAV_ITEMS rather than mapping over MOBILE_PAGE_IDS so that a
 * feature-gated destination (`cdr`, `radio-signal`) disappears from the mobile
 * nav exactly when its flag is off — NAV_ITEMS is already the authority on
 * that, and re-deriving it here would be a second copy to keep in step.
 */
export function mobileNavItems(): NavItem[] {
  return NAV_ITEMS.filter(i => MOBILE_ID_SET.has(i.id));
}

/** Destinations that exist in this build but need a desktop. */
export function desktopOnlyNavItems(): NavItem[] {
  return NAV_ITEMS.filter(i => !MOBILE_ID_SET.has(i.id));
}
