import * as fs from 'fs';
import * as path from 'path';

/**
 * Every write route carries requireAdmin, or is on the list below with a reason.
 *
 * This exists because the guard is applied PER ROUTE in 60-odd controllers
 * rather than once with `app.use`, so a new write route is admin-only only if
 * whoever added it remembered. index.ts still imported `requireAdmin` under a
 * comment claiming "requireAdmin middleware applied before routers that have
 * write operations" — an approach that was replaced by the per-route guards
 * and left a dead import and a misleading comment behind. Measured when this
 * test was written: 340 write routes guarded, 25 not, and one of those 25 was
 * POST /api/autoconfig/start, which re-addresses and reinstalls the entire
 * deployment.
 *
 * The allow-list is the point of the test as much as the assertion is: a route
 * reachable by a viewer should be a decision someone wrote down, not an
 * omission nobody measured.
 */

const REST_DIR = path.join(__dirname, '..');

/**
 * Write routes a viewer may reach, each with why.
 *
 * Keyed `<file>:<METHOD> <route path>`. Adding a line here is a deliberate
 * authorization decision; the assertion below is what makes you make it.
 */
const VIEWER_WRITABLE: Record<string, string> = {
  // Mounted BEFORE app.use('/api', authMiddleware) — there is no session yet.
  "auth-controller.ts:POST '/login'": 'Public by necessity: this is how a session is obtained.',
  "auth-controller.ts:POST '/logout'": 'Ending your own session needs no privilege.',

  // POST because the request carries a body, not because it writes anything.
  "ip-plan-controller.ts:POST '/propose'":
    'Pure preview. Computes non-colliding suggestions and returns them; '
    + 'POST /apply is the only write path and IS guarded.',
  "sip-trace-controller.ts:POST '/call-debug/resolve'":
    'Read-only preview of what each number resolved to, so an operator can see '
    + 'a party is unregistered before spending a real test call. '
    + '/call-debug/start and /stop are guarded.',

  // RF propagation maths. No host state, no stored state, no device touched.
  "rf-planning-controller.ts:POST '/link-budget'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-planning-controller.ts:POST '/point-analysis'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-planning-controller.ts:POST '/path-loss'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-planning-controller.ts:POST '/coverage-grid'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-planning-controller.ts:POST '/interference-grid'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/simulate'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/building-entry'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/optimize'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/recommend-sites'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/validate-measurements'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/coverage-heatmap'": 'Pure propagation maths. Touches no host, device or stored state.',
  "rf-simulation-controller.ts:POST '/report.pdf'": 'Renders the workspace it is given; stores nothing.',
  "rf-simulation-controller.ts:POST '/buildings/import'":
    'Fetches OpenStreetMap footprints and returns them. Despite the name it '
    + 'imports into the RESPONSE, not into any collection.',
  "rf-planning-projects-controller.ts:POST '/:id/compare-sites'": 'Reads a stored project and computes; writes nothing back to it.',
  "rf-planning-projects-controller.ts:POST '/:id/interference'": 'Reads a stored project and computes; writes nothing back to it.',
};

interface WriteRoute { file: string; method: string; routePath: string; line: number; guard: string | null }

function writeRoutesOf(file: string): WriteRoute[] {
  const src = fs.readFileSync(path.join(REST_DIR, file), 'utf-8');
  const out: WriteRoute[] = [];
  // `router.<verb>('<path>', <next token>` — the guard, when there is one, is
  // always the first argument after the path.
  const re = /router\.(post|put|patch|delete)\(\s*('[^']*'|"[^"]*")\s*,\s*([A-Za-z_]\w*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({
      file,
      method: m[1].toUpperCase(),
      routePath: m[2].replace(/"/g, "'"),
      line: src.slice(0, m.index).split('\n').length,
      guard: m[3] ?? null,
    });
  }
  return out;
}

function allWriteRoutes(): WriteRoute[] {
  return fs.readdirSync(REST_DIR)
    .filter(f => f.endsWith('-controller.ts'))
    .sort()
    .flatMap(writeRoutesOf);
}

describe('write routes are admin-only', () => {
  const routes = allWriteRoutes();

  it('finds the write routes at all — a regex that matches nothing would pass everything', () => {
    // Guards the test itself: if the router idiom changes, this fails loudly
    // rather than silently reporting a clean sweep of zero routes.
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.some(r => r.guard === 'requireAdmin')).toBe(true);
    expect(new Set(routes.map(r => r.file)).size).toBeGreaterThan(40);
  });

  it('every write route is guarded or explicitly allow-listed', () => {
    const unexplained = routes
      .filter(r => r.guard !== 'requireAdmin')
      .filter(r => !(`${r.file}:${r.method} ${r.routePath}` in VIEWER_WRITABLE))
      .map(r => `${r.file}:${r.line} ${r.method} ${r.routePath}`);
    // A new write route fails here until it either takes requireAdmin or is
    // added to VIEWER_WRITABLE with a reason.
    expect(unexplained).toEqual([]);
  });

  it('the allow-list has no stale entries', () => {
    // A route that was later guarded, renamed or deleted should lose its
    // exemption rather than sit there implying a decision that no longer
    // applies to anything.
    const live = new Set(routes
      .filter(r => r.guard !== 'requireAdmin')
      .map(r => `${r.file}:${r.method} ${r.routePath}`));
    expect(Object.keys(VIEWER_WRITABLE).filter(k => !live.has(k))).toEqual([]);
  });

  it('every allow-list entry states a reason', () => {
    for (const [route, reason] of Object.entries(VIEWER_WRITABLE)) {
      // Not a style rule. The floor is here so an exemption cannot be added
      // with a placeholder like 'ok' or 'n/a' -- a sentence is roughly the
      // least that can actually say why a viewer may reach a write route,
      // and writing it is the review this test is trying to force.
      expect(reason.length).toBeGreaterThan(20);
      expect(reason.trim()).toMatch(/[.!]$/);
      expect(route).toMatch(/^[\w.-]+\.ts:(POST|PUT|PATCH|DELETE) '/);
    }
  });

  it('the destructive module-lifecycle and migration routes are all guarded', () => {
    // Named rather than counted: these are the ones whose blast radius is the
    // real host — installing packages, writing host config, restarting NFs,
    // re-addressing interfaces. POST /api/autoconfig/start was the one of
    // these found unguarded.
    const mustGuard = /\/(start|install|uninstall|remove|configure|apply|restart|stop|rollback|migrate|reset|block|unblock|factory)/;
    const holes = routes
      .filter(r => r.guard !== 'requireAdmin' && mustGuard.test(r.routePath))
      .map(r => `${r.file}:${r.line} ${r.method} ${r.routePath}`);
    expect(holes).toEqual([]);
  });
});
