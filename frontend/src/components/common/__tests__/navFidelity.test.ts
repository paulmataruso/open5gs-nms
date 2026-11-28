import { describe, it, expect } from 'vitest';
import appSource from '../../../App.tsx?raw';
import navSource from '../navItems.ts?raw';
import {
  NAV_ITEMS, MOBILE_PRIMARY_TAB_IDS, mobilePrimaryTabs,
  navLabelFor, isKnownNavTab,
} from '../navItems';
import {
  MOBILE_PAGE_IDS, isMobilePageId, mobileNavItems, desktopOnlyNavItems,
} from '../../../mobile/mobileNav';

/**
 * Every navigation destination resolves to a page this build can render.
 *
 * WHY. App.tsx renders a page with `switch (activeTab)`, where activeTab is a
 * NAV_ITEMS id. A nav entry with no matching `case` therefore falls to
 * `default` -- the menu item is visible and clicking it silently shows
 * something else. That is the same class of fault as a frontend calling a
 * backend route that does not exist (see ui-backend-route-fidelity.test.ts),
 * and it is equally invisible without a test: nothing throws, nothing logs,
 * and the page that appears looks deliberate.
 *
 * The reverse direction matters too. navItems.ts's own comment says a
 * destination missing from one shell "looks exactly like a feature that is
 * switched off", which is precisely why a human will not notice it.
 *
 * App.tsx is read as source rather than rendered. Mounting it would pull in 37
 * lazily-imported pages, every store, and the auth context, to assert
 * something that is purely a property of its switch -- and the frontend has no
 * @types/node, so the source arrives through Vite's `?raw` rather than fs.
 */

/** Every `case '<id>':` in App.tsx, comments stripped first. */
function renderCases(): string[] {
  const src = appSource.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return Array.from(src.matchAll(/^\s*case '([^']+)':/gm), (m) => m[1]);
}

/**
 * Every id navItems.ts DECLARES, including the ones this build hides.
 *
 * Read from source rather than from NAV_ITEMS, and that distinction is the
 * point. NAV_ITEMS is filtered by FEATURES at module load, so on this host --
 * where pstn, mms, cdr, gsm and others are off -- it holds 25 of the 38
 * declared destinations. Comparing the switch against the FILTERED list would
 * therefore check only the configuration this .env happens to produce, and a
 * module added with its flag off would never be checked at all. Comparing
 * against the declared list checks every build.
 */
function declaredIds(): string[] {
  const src = navSource.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return Array.from(src.matchAll(/\bid: '([^']+)'/g), (m) => m[1]);
}

const CASES = renderCases();
const DECLARED = declaredIds();
const IDS = NAV_ITEMS.map((i) => i.id);

describe('the nav list and the render switch agree', () => {
  it('finds both lists at all — an empty scan would pass everything', () => {
    // Guards the test itself. If App.tsx stops using a switch, this fails
    // loudly rather than reporting a clean sweep of nothing.
    expect(CASES.length).toBeGreaterThan(30);
    expect(DECLARED.length).toBeGreaterThan(30);
    expect(CASES).toContain('dashboard');
    expect(DECLARED).toContain('dashboard');
    // This build really is a filtered subset, so the distinction the test
    // rests on is live rather than hypothetical.
    expect(IDS.length).toBeLessThan(DECLARED.length);
  });

  it('every declared destination has a case in App.tsx', () => {
    // The failure this exists for: a visible menu item that renders the
    // default page. Checked against the declared list so it also covers a
    // module whose flag is off in this build.
    expect(DECLARED.filter((id) => !CASES.includes(id))).toEqual([]);
  });

  it('every case is a declared destination', () => {
    // The other direction: a case for an id no nav list offers is a page
    // nothing can reach, which is how a renamed destination leaves its old
    // page behind still compiling.
    expect(CASES.filter((c) => !DECLARED.includes(c))).toEqual([]);
  });

  it('this build shows a subset of the declared destinations, never an extra', () => {
    expect(IDS.filter((id) => !DECLARED.includes(id))).toEqual([]);
  });

  it('every feature-gated destination is gated in the renderer too', () => {
    // A destination the sidebar hides behind a flag must ALSO be behind that
    // flag in App.tsx, or its page still renders for anyone whose URL hash
    // names it. The pairing is what makes a module switched off actually off.
    //
    // It matters most for gsm-signal, the one id isKnownNavTab accepts while
    // its own module is disabled (see the NON_SIDEBAR_TAB_IDS test below): for
    // that id the renderer's gate is the ONLY thing standing between a
    // disabled module and its page on screen.
    const gatedNav = new Map(
      Array.from(
        navSource.matchAll(/FEATURES\.(\w+)\s*\?\s*\[\{\s*id: '([^']+)'/g),
        (m) => [m[2], m[1]] as const,
      ),
    );
    const gatedCases = new Set(
      Array.from(
        appSource.matchAll(/case '([^']+)':\s*\n\s*return FEATURES\.\w+\s*\?/g),
        (m) => m[1],
      ),
    );
    // Guards the scan: if either pattern stops matching, this fails rather
    // than sweeping an empty set.
    expect(gatedNav.size).toBeGreaterThan(10);
    expect(gatedCases.size).toBeGreaterThan(10);
    expect(gatedNav.has('gsm-signal')).toBe(true);

    expect([...gatedNav.keys()].filter((id) => !gatedCases.has(id))).toEqual([]);
  });

  it('App.tsx has a default case, so an unknown id cannot render nothing', () => {
    expect(appSource).toMatch(/^\s*default:/m);
  });

  it('no id appears twice in either list', () => {
    // A duplicate case is dead code after the first; a duplicate nav id gives
    // two menu rows that go to one place.
    expect(IDS).toEqual(Array.from(new Set(IDS)));
    expect(CASES).toEqual(Array.from(new Set(CASES)));
  });
});

describe('isKnownNavTab gates what the URL hash may hold', () => {
  it('accepts every destination this build renders', () => {
    // It decides whether an id from the hash is kept in nav state, so a
    // destination it rejects is one a bookmark or a reload cannot reach.
    for (const id of IDS) expect(isKnownNavTab(id)).toBe(true);
  });

  it('rejects a destination this build hides, which is the point of it', () => {
    // Its own comment: stop "a bogus or feature-disabled id from the URL hash
    // being held in nav state". On this host 2G, PSTN, MMS and CDR are off.
    const hidden = DECLARED.filter((id) => !IDS.includes(id) && id !== 'gsm-signal');
    expect(hidden.length).toBeGreaterThan(5);
    for (const id of hidden) expect(isKnownNavTab(id)).toBe(false);
  });

  it('accepts gsm-signal even while 2G is off — a small inconsistency, pinned', () => {
    // navItems.ts keeps NON_SIDEBAR_TAB_IDS for destinations "reachable only
    // from inside another page and so never appear in the sidebar", and its
    // one member is 'gsm-signal' -- which IS a sidebar row, at navItems.ts:60,
    // gated on FEATURES.gsm. So the entry is redundant whenever 2G is on, and
    // while 2G is off it does the opposite of what the list is for: the id
    // stays valid, the hash goes on reading #gsm-signal, and App.tsx's own
    // flag gate renders the dashboard underneath it.
    //
    // Pinned as it stands rather than corrected, because resolving it is a
    // nav-structure decision: either the sidebar row is right and the list
    // entry should go, or the page is meant to be opened only from GsmPage and
    // the row should. Nothing is reachable that should not be, either way --
    // every gated case falls back to the dashboard, asserted above.
    expect(isKnownNavTab('gsm-signal')).toBe(true);
    expect(IDS).not.toContain('gsm-signal');
    expect(navSource).toContain("NON_SIDEBAR_TAB_IDS = ['gsm-signal']");
  });

  it('rejects anything else, including near-misses and empty input', () => {
    for (const bogus of ['', ' ', 'dashboard ', 'Dashboard', 'ran/', 'nope', '../etc/passwd']) {
      expect(isKnownNavTab(bogus)).toBe(false);
    }
  });
});

describe('the mobile shells between them cover every destination', () => {
  it('mobileNavItems and desktopOnlyNavItems partition NAV_ITEMS exactly', () => {
    // The documented failure mode: a destination missing from both shells is
    // indistinguishable from a feature that is switched off. Partition, so
    // neither a gap nor an overlap is possible.
    const mobile = mobileNavItems().map((i) => i.id);
    const desktop = desktopOnlyNavItems().map((i) => i.id);
    expect([...mobile, ...desktop].sort()).toEqual([...IDS].sort());
    expect(mobile.filter((id) => desktop.includes(id))).toEqual([]);
  });

  it('every mobile page id is a real destination in this build', () => {
    // MOBILE_PAGE_IDS is a hand-written list; an id that is not in NAV_ITEMS
    // contributes a mobile page nothing can navigate to.
    // Against DECLARED, not NAV_ITEMS: `cdr` is a real mobile page whose flag
    // is off on this host, and filtering it out of the nav is exactly what
    // mobileNavItems() is documented to do.
    expect(MOBILE_PAGE_IDS.filter((id) => !DECLARED.includes(id))).toEqual([]);
    for (const id of MOBILE_PAGE_IDS) expect(isMobilePageId(id)).toBe(true);
    // ...and each one renders.
    for (const id of MOBILE_PAGE_IDS) expect(CASES).toContain(id);
    expect(isMobilePageId('config')).toBe(false);
    expect(isMobilePageId('')).toBe(false);
  });

  it('the bottom tab bar stays within five columns, and all of them resolve', () => {
    // Five is the documented ceiling: on a 320px screen five columns leave
    // ~56px of content width each.
    expect(MOBILE_PRIMARY_TAB_IDS.length).toBeLessThanOrEqual(5);
    const tabs = mobilePrimaryTabs();
    expect(tabs.map((t) => t.id)).toEqual([...MOBILE_PRIMARY_TAB_IDS]);
    // Each is also a mobile page, or tapping it lands on a desktop-only view.
    for (const id of MOBILE_PRIMARY_TAB_IDS) expect(isMobilePageId(id)).toBe(true);
  });

  it('every bottom-bar tab whose label is long carries a shortLabel', () => {
    // The icon set reuses `Activity` for Dashboard and Services and `Wifi` for
    // three destinations, so in the bottom bar the label is the ONLY
    // disambiguator -- and "RAN Network" and "Unified Logs" both clip there.
    for (const tab of mobilePrimaryTabs()) {
      if (tab.label.length > 10) {
        expect(tab.shortLabel, `${tab.id} needs a shortLabel`).toBeTruthy();
        expect(tab.shortLabel!.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it('mobilePrimaryTabs drops an id this build hides rather than returning a hole', () => {
    // It resolves ids through NAV_ITEMS and filters undefined, so a
    // feature-gated primary tab yields a shorter bar, never an empty slot that
    // renders as a blank column.
    expect(mobilePrimaryTabs().every((t) => t !== undefined)).toBe(true);
    expect(mobilePrimaryTabs().length).toBeLessThanOrEqual(MOBILE_PRIMARY_TAB_IDS.length);
  });
});

describe('nav labels', () => {
  it('returns each destination its own label', () => {
    for (const item of NAV_ITEMS) expect(navLabelFor(item.id)).toBe(item.label);
  });

  it('falls back to Dashboard for an id it does not know', () => {
    // The mobile top bar always shows something; a blank title reads as a
    // failed render.
    expect(navLabelFor('nope')).toBe('Dashboard');
    expect(navLabelFor('')).toBe('Dashboard');
  });

  it('gives every destination a non-empty label and an icon', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });

  it('has no two destinations sharing a label', () => {
    // The sidebar shows labels, not ids, so two rows reading the same thing
    // are indistinguishable to whoever is clicking.
    const labels = NAV_ITEMS.map((i) => i.label);
    expect(labels).toEqual(Array.from(new Set(labels)));
  });
});
