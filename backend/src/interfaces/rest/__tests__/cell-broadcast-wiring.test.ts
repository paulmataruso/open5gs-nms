import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf-8');
const ENV = read('.env.example');
const COMPOSE = read('docker-compose.yml');
const DOCKERFILE = read('frontend/Dockerfile');
const FEATURES = read('frontend/src/config/features.ts');
const NAV = read('frontend/src/components/common/navItems.ts');
const APP = read('frontend/src/App.tsx');
const MOBILE_NAV = read('frontend/src/mobile/mobileNav.ts');
const MOBILE_PAGES = read('frontend/src/mobile/mobilePages.tsx');

/**
 * Cell Broadcast arrived with no module flag at all, so its nav entry showed on
 * every deployment -- unlike all twenty other optional modules -- for a feature
 * that is inert without an MME built with explicit SBc-AP TAI routing.
 *
 * It also listed itself in MOBILE_PAGE_IDS while pointing at the DESKTOP page,
 * the only entry doing so; mobileNav.ts's own comment says a page without a
 * mobile component is left out and treated as desktop-only, "which is honest."
 * A cramped desktop form on a phone is a poor place to dispatch a public
 * emergency alert.
 */
describe('Cell Broadcast — module flag wiring', () => {
  it('is opt-in in .env.example', () => {
    expect(ENV).toMatch(/^ENABLE_CELL_BROADCAST_MODULE=false$/m);
  });

  it('is plumbed from .env through compose and the Dockerfile to Vite', () => {
    // Compose passing a build arg the Dockerfile never declares is silently
    // DROPPED by Docker — the gap that already shipped once for DHCP.
    expect(COMPOSE).toMatch(/VITE_ENABLE_CELL_BROADCAST=\$\{ENABLE_CELL_BROADCAST_MODULE:-false\}/);
    expect(DOCKERFILE).toMatch(/^ARG VITE_ENABLE_CELL_BROADCAST=false$/m);
    expect(DOCKERFILE).toMatch(/^ENV VITE_ENABLE_CELL_BROADCAST=\$VITE_ENABLE_CELL_BROADCAST$/m);
    expect(FEATURES).toMatch(/cellBroadcast: import\.meta\.env\.VITE_ENABLE_CELL_BROADCAST === 'true'/);
  });

  it('gates both the nav entry and the route, not just one', () => {
    // Gating only the nav leaves the page reachable by its id; gating only the
    // route leaves a visible entry that renders the dashboard.
    expect(NAV).toMatch(/FEATURES\.cellBroadcast \? \[\{ id: 'cell-broadcast'/);
    expect(APP).toMatch(/FEATURES\.cellBroadcast \? <CellBroadcastPage \/> : <DashboardPage \/>/);
  });

  it('is desktop-only, since it has no Mobile* component', () => {
    expect(MOBILE_NAV).not.toMatch(/'cell-broadcast'/);
    expect(MOBILE_PAGES).not.toMatch(/CellBroadcastPage/);
  });

  it('keeps every other mobile page mapped to a real mobile component', () => {
    // What made the original entry wrong: every sibling maps to ./Mobile*Page.
    const imports = [...MOBILE_PAGES.matchAll(/lazy\(\(\) => import\('([^']+)'\)/g)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^\.\/Mobile/);
  });
});
