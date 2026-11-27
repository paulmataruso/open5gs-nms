import * as fs from 'fs';
import * as path from 'path';

/**
 * Every HTTP call the frontend makes must reach a route the backend actually
 * registers.
 *
 * This is the first piece of the UI-to-backend fidelity work, and it answers
 * the cheapest version of the question: does the button reach anything at all?
 * It does NOT check that the handler then writes the right config — that is
 * per-feature work the `*-wiring` and `*-golden` tests do. What it does check
 * is the failure nothing else catches: a route renamed or re-mounted on the
 * backend leaves a control in the UI that 404s, and because the frontend and
 * backend are separate TypeScript projects, no compiler anywhere sees it. The
 * only existing signal is someone clicking it.
 *
 * Measured when this was written: 594 backend routes, and 514 frontend call
 * sites across three surfaces, ALL of which resolve. So this starts from a
 * clean sheet and its job is to keep it that way.
 *
 * It lives in the backend suite because that is the run which already crosses
 * the workspace boundary (jest imports three pure frontend modules directly),
 * and because the backend is where a route gets renamed.
 *
 * ── Why a text analysis rather than importing either side ──
 * The backend's route table only exists after `main()` has connected to Mongo,
 * opened SQLite and bound a port. The frontend's calls only exist inside
 * component callbacks. Reading the source is what makes this checkable at all,
 * so the real risk is a regex that silently matches nothing — which is why the
 * first test in each group is a self-guard with a floor under it.
 */

const REPO = path.join(__dirname, '..', '..', '..', '..', '..');
const BACKEND_INDEX = path.join(REPO, 'backend', 'src', 'index.ts');
const BACKEND_SRC = path.join(REPO, 'backend', 'src');
const FRONTEND_SRC = path.join(REPO, 'frontend', 'src');

const METHODS = 'get|post|put|patch|delete';

/** Source with `//` comments removed, so prose never counts as code. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walk(p, out);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Backend: the real route table, as mounted
// ─────────────────────────────────────────────────────────────

interface Route { method: string; path: string }

/**
 * Router factories, by exported name.
 *
 * BOTH declaration forms. Roughly a sixth of these are
 * `export const createXRouter = (` arrow functions rather than
 * `export function` — including tun, interface, radio-tags, the three radio
 * block routers and traffic-history — and a resolver that only knew the
 * `function` form silently dropped 11 mounts and 21 frontend calls with them,
 * which then looked like 21 broken buttons.
 */
function routerFactories(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(BACKEND_SRC)) {
    for (const m of code(file).matchAll(/export (?:function|const)\s+(create\w+)/g)) {
      out.set(m[1], file);
    }
  }
  return out;
}

/**
 * The routes a router file registers, optionally restricted to ONE router
 * variable.
 *
 * `router` is the usual name but not the only one: cell-broadcast-controller
 * declares `const admin=Router(), external=Router()` and registers on each,
 * and index.ts mounts them at two different prefixes. Passing the member name
 * through from the mount keeps the external API's routes out of the admin
 * prefix instead of merging both into a permissive union.
 */
function routesIn(file: string, member?: string): Route[] {
  const src = code(file);
  const routerVars = new Set(Array.from(src.matchAll(/(\w+)\s*=\s*Router\(\)/g), (m) => m[1]));
  const use = member && routerVars.has(member) ? new Set([member]) : routerVars;
  const out: Route[] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\b(\w+)\.(${METHODS})\(\s*'([^']*)'`, 'g'))) {
    if (use.has(m[1])) out.push({ method: m[2].toUpperCase(), path: m[3] });
  }
  return out;
}

interface Mount { prefix: string; factory: string; file: string | undefined; member?: string }

function mounts(): Mount[] {
  const src = code(BACKEND_INDEX);
  const factories = routerFactories();
  // `const cellBroadcastRouters = createCellBroadcastRouters(...)` — the mount
  // then names the variable, not the factory.
  const varToFactory = new Map(
    Array.from(src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(create\w+)\(/g), (m) => [m[1], m[2]] as const),
  );
  const out: Mount[] = [];
  for (const m of src.matchAll(/app\.use\(\s*'(\/api[^']*)'\s*,\s*([A-Za-z_]\w*)(?:\.(\w+))?/g)) {
    const name = m[2];
    const factory = factories.has(name) ? name : (varToFactory.get(name) ?? name);
    out.push({ prefix: m[1], factory, file: factories.get(factory), member: m[3] });
  }
  return out;
}

function join(prefix: string, rest: string): string {
  return (`${prefix.replace(/\/$/, '')}/${rest.replace(/^\//, '')}`).replace(/\/\/+/g, '/').replace(/\/$/, '') || '/';
}

function backendRoutes(): Route[] {
  const out: Route[] = [];
  for (const mount of mounts()) {
    if (!mount.file) continue;
    for (const r of routesIn(mount.file, mount.member)) {
      out.push({ method: r.method, path: join(mount.prefix, r.path) });
    }
  }
  // Declared straight on `app`, bypassing every router — /api/health is one.
  for (const m of code(BACKEND_INDEX).matchAll(new RegExp(String.raw`app\.(${METHODS})\(\s*'(\/api[^']*)'`, 'g'))) {
    out.push({ method: m[1].toUpperCase(), path: m[2].replace(/\/$/, '') });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Frontend: every call site, across all three surfaces
// ─────────────────────────────────────────────────────────────

interface Call { file: string; method: string; path: string }

/** `${...}` becomes a parameter placeholder; a query string is not part of the route. */
function toRoutePath(url: string): string {
  return url.split('?')[0].replace(/\$\{[^}]*\}/g, ':p').replace(/\/$/, '') || '/';
}

/** `import.meta.env.VITE_API_URL || '/api'` resolves to its fallback. */
function stripEnv(s: string): string {
  return s.replace(/\$\{\s*import\.meta\.env\.\w+\s*\|\|\s*''\s*\}/g, '')
          .replace(/\$\{\s*import\.meta\.env\.\w+\s*\}/g, '');
}

/**
 * A URL written out in full (as opposed to relative to an axios baseURL),
 * resolved to a backend path — or null when this analysis cannot say.
 *
 * `${SOMETHING}/rest` is resolved from that file's own base constants, and a
 * bare `${import.meta.env.VITE_API_URL || ''}` prefix is dropped.
 */
function absolutePath(raw: string, bases: Map<string, string>): string | null {
  let url = raw;
  const named = /^\$\{(\w+)(?:\(\))?\}/.exec(url);
  if (named && bases.has(named[1])) url = bases.get(named[1])! + url.slice(named[0].length);
  else url = stripEnv(url);
  if (!url.startsWith('/api/') && url !== '/api') return null;
  return toRoutePath(url);
}

function frontendCalls(): { calls: Call[]; unresolved: Call[] } {
  const calls: Call[] = [];
  const unresolved: Call[] = [];
  for (const file of walk(FRONTEND_SRC)) {
    const src = code(file);
    const rel = path.relative(FRONTEND_SRC, file);

    // (1) axios instances: baseURL from axios.create, per variable, because a
    //     file can hold several (frr.ts has `api` and `sourceBuildApi`).
    const bases = new Map<string, string>();
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*axios\.create\(\s*\{[\s\S]*?baseURL:\s*(`[^`]*`|'[^']*')/g)) {
      bases.set(m[1], stripEnv(m[2].slice(1, -1)).replace(/\/$/, ''));
    }
    // (2) plain string/template consts used as a base by fetch.
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:\(\)\s*=>\s*)?\(?\s*(`[^`]*`|'[^']*')/g)) {
      const v = stripEnv(m[2].slice(1, -1));
      if (v.startsWith('/api')) bases.set(m[1], v.replace(/\/$/, ''));
    }
    // `const API = import.meta.env.VITE_API_URL || '/api'`, with or without an
    // arrow wrapper — every component that talks to the backend without going
    // through src/api uses exactly this shape.
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:\(\)\s*=>\s*)?\(?\s*import\.meta\.env\.\w+\s*\|\|\s*'([^']*)'/g)) {
      bases.set(m[1], m[2].replace(/\/$/, ''));
    }

    // (2b) A module-local wrapper that composes the path itself:
    //      `async function post<T>(path: string, body) { fetch(`/api/rf-planning${path}`, {method:'POST'}) }`
    //      and then `post('/simulate', body)` at eleven call sites. The real
    //      paths live at those call sites, so without this the whole module
    //      reads as two calls to `/api/rf-planning:p` — which is not a route,
    //      and would have had to be exempted to make this test pass. That is
    //      the trap: an exemption here hides eleven real calls.
    const wrappers = new Map<string, { base: string; method: string }>();
    for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(\s*path\s*:\s*string[\s\S]{0,600}?fetch\(\s*`([^`]*)\$\{path\}`([\s\S]{0,200}?)\)/g)) {
      const base = stripEnv(m[2]).replace(/\/$/, '');
      if (!base.startsWith('/api')) continue;
      wrappers.set(m[1], { base, method: (/method:\s*'(\w+)'/.exec(m[3] ?? '')?.[1] ?? 'GET').toUpperCase() });
    }
    for (const [name, w] of wrappers) {
      // `(?<![.\w])` so a method call like `index.get(...)` on a Map is not
      // read as this module's own `get` wrapper, and `[^()<>]` so the generic
      // argument cannot span across unrelated code to reach a later string —
      // with `[\s\S]*?` there it matched `post<...>('/simulate')` as a call to
      // `get`, inventing a GET route that does not exist.
      for (const m of src.matchAll(new RegExp(String.raw`(?<![.\w])${name}\s*(?:<[^()<>]*>)?\(\s*('[^']*'|\`[^\`]*\`)`, 'g'))) {
        calls.push({ file: rel, method: w.method, path: toRoutePath(join(w.base, m[1].slice(1, -1))) });
      }
    }

    for (const m of src.matchAll(new RegExp(String.raw`\b(\w+)\.(${METHODS})(?:<[^>]*>)?\(\s*(\`[^\`]*\`|'[^']*')`, 'g'))) {
      const receiver = m[1];
      const method = m[2].toUpperCase();
      const url = m[3].slice(1, -1);
      if (/^https?:/.test(url)) continue; // a third-party service, not us

      const base = bases.get(receiver);
      if (base !== undefined) {
        calls.push({ file: rel, method, path: toRoutePath(join(base, url)) });
        continue;
      }
      // (2c) `axios.get(...)` on the imported module rather than an instance.
      //      31 call sites across the pages do this, and skipping them was a
      //      real hole: five of the six chrony calls on the Time Server page
      //      were invisible to this test, which a mutation renaming the route
      //      they use exposed by NOT failing. A call this analysis cannot
      //      resolve now has to be declared, not dropped.
      if (receiver === 'axios') {
        const resolved = absolutePath(url, bases);
        if (resolved === null) unresolved.push({ file: rel, method, path: url });
        else calls.push({ file: rel, method, path: resolved });
        continue;
      }
      // Anything else is a DOM or library call that happens to share a name
      // (`searchParams.get('q')`, `headers.get('content-type')`). These cannot
      // be told apart from an api call by shape, which is why the per-module
      // integrity test below exists.
    }

    // (3) fetch(), which the streaming install/uninstall endpoints must use —
    //     axios buffers a chunked response, so those cannot go through (1).
    for (const m of src.matchAll(/fetch\(\s*(`[^`]*`|'[^']*'|\w+)\s*([^)]*)/g)) {
      const token = m[1];
      const rest = m[2] ?? '';
      const method = (/method:\s*'(\w+)'/.exec(rest)?.[1] ?? 'GET').toUpperCase();
      let raw: string;
      if (/^[`']/.test(token)) {
        raw = token.slice(1, -1);
        if (/^https?:/.test(raw)) continue;
      } else {
        const base = bases.get(token);
        if (base === undefined) continue; // fetch(someRequestObject)
        raw = base;
      }
      // The wrapper's own fetch is handled above, at its call sites; counting
      // it here too would add a `/api/rf-planning:p` that is not a route.
      if (/\$\{path\}/.test(raw)) continue;
      const resolved = absolutePath(raw, bases);
      if (resolved === null) unresolved.push({ file: rel, method, path: raw });
      else calls.push({ file: rel, method, path: resolved });
    }
  }
  return { calls, unresolved };
}

/** Does a frontend path reach this backend route? `:param` and a trailing `*` both match. */
function reaches(call: Call, route: Route): boolean {
  if (call.method !== route.method) return false;
  const want = call.path.split('/');
  const have = route.path.split('/');
  if (have[have.length - 1] === '*') {
    if (want.length < have.length - 1) return false;
    return have.slice(0, -1).every((seg, i) => seg === want[i] || seg.startsWith(':'));
  }
  if (want.length !== have.length) return false;
  // Either side may be a parameter: the frontend's comes from a `${}`, the
  // backend's from `:id`.
  return have.every((seg, i) => seg === want[i] || seg.startsWith(':') || want[i].startsWith(':'));
}

const routes = backendRoutes();
const { calls, unresolved } = frontendCalls();

describe('the UI reaches routes the backend really has', () => {
  it('finds both sides at all — a regex matching nothing would pass everything', () => {
    // Floors, not exact counts, so adding features does not fail this.
    expect(routes.length).toBeGreaterThan(500);
    expect(calls.length).toBeGreaterThan(450);
    expect(new Set(calls.map((c) => c.file)).size).toBeGreaterThan(40);
    expect(routes.some((r) => r.path === '/api/health')).toBe(true);
    expect(routes.some((r) => r.path.endsWith('/*'))).toBe(true);
  });

  it('every app.use mount resolves to a router file', () => {
    // An unresolved mount drops every route under it, which turns real
    // frontend calls into apparent 404s. This is the assertion that would
    // have caught the arrow-function factory form.
    const bad = mounts().filter((m) => !m.file).map((m) => `${m.prefix} -> ${m.factory}`);
    expect(bad).toEqual([]);
    expect(mounts().length).toBeGreaterThan(70);
  });

  it('every frontend call reaches a backend route', () => {
    const dead = calls
      .filter((c) => !routes.some((r) => reaches(c, r)))
      .map((c) => `${c.method} ${c.path}  (frontend/src/${c.file})`)
      .sort();
    // Each entry here is a control in the UI that cannot work. Either the
    // backend route was renamed or removed, or the client was written against
    // a path that never existed.
    expect(Array.from(new Set(dead))).toEqual([]);
  });

  it('no frontend fetch() of the backend is left unresolved', () => {
    // A call this analysis cannot resolve is a call it is not checking, so it
    // must be visible rather than silently skipped. If one appears, either
    // give it a resolvable base or add it here with a reason.
    expect(unresolved.map((u) => `${u.method} ${u.path} (${u.file})`).sort()).toEqual([]);
  });

  it('every api module contributes at least one resolved call', () => {
    // The integrity check for everything above. A call whose receiver is not
    // a recognised base is skipped silently -- it has to be, since
    // `searchParams.get('q')` and `headers.get('content-type')` look
    // identical to an api call -- so the risk is not a false failure but a
    // whole module quietly going unchecked. If a client is rewritten in a
    // shape the resolver does not know, its file disappears from `calls` and
    // this is what notices.
    const seen = new Set(calls.filter((c) => c.file.startsWith('api/')).map((c) => c.file));
    const apiDir = path.join(FRONTEND_SRC, 'api');
    const silent = fs.readdirSync(apiDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /axios|fetch\(/.test(code(path.join(apiDir, f))))
      .filter((f) => !seen.has(path.join('api', f)));
    expect(silent).toEqual([]);
    expect(seen.size).toBeGreaterThan(30);
  });

  it('every page that talks to the backend directly is represented too', () => {
    // The twin of the test above, for the surface OUTSIDE src/api: the pages
    // that call `axios.get(`${API()}/...`)` or `fetch('/api/...')` themselves,
    // mostly for the streaming install endpoints that axios cannot consume.
    //
    // This exists because of a measured miss. The resolver originally skipped
    // every direct `axios.<method>` call — 31 of them — and a mutation
    // renaming the chrony route the Time Server page uses did NOT fail,
    // because five of that page's six calls were invisible. Restoring the
    // skip now fails this.
    const seen = new Set(calls.filter((c) => !c.file.startsWith('api/')).map((c) => c.file));
    const silent: string[] = [];
    for (const file of walk(FRONTEND_SRC)) {
      const rel = path.relative(FRONTEND_SRC, file);
      if (rel.startsWith(`api${path.sep}`)) continue;
      const src = code(file);
      // Only files that clearly address this backend: a literal /api path, or
      // a base constant resolved from VITE_API_URL.
      const addresses = new RegExp(String.raw`(?:fetch|axios\.(?:${METHODS}))\(\s*[\`'](?:/api/|\$\{\w+(?:\(\))?\}/)`).test(src);
      if (addresses && !seen.has(rel)) silent.push(rel);
    }
    expect(silent).toEqual([]);
    expect(seen.size).toBeGreaterThan(15);
  });

  it('one canary per call shape, so a resolver branch cannot go quietly dead', () => {
    // The two integrity tests above catch a whole FILE disappearing. They do
    // not catch one resolver branch dying while another keeps the same file
    // represented — measured: deleting the local-wrapper resolution loses
    // nine real rf-planning calls, and rfSimulation.ts stays "seen" through
    // its one literal `fetch('/api/rf-planning/report.pdf')`. So each shape
    // gets a named representative.
    const canaries: Array<[string, Call]> = [
      ['axios instance with a baseURL',
        { file: path.join('api', 'ims.ts'), method: 'GET', path: '/api/ims/status' }],
      ['axios module called directly on a page',
        { file: path.join('pages', 'TimeServerPage.tsx'), method: 'GET', path: '/api/chrony/status' }],
      ['fetch with a literal path',
        { file: path.join('api', 'rfSimulation.ts'), method: 'POST', path: '/api/rf-planning/report.pdf' }],
      ['fetch against a module base constant',
        { file: path.join('api', 'qciHwTest.ts'), method: 'GET', path: '/api/validation/qci-hw-test/status' }],
      ['a module-local wrapper that composes the path',
        { file: path.join('api', 'rfSimulation.ts'), method: 'POST', path: '/api/rf-planning/simulate' }],
    ];
    const missing = canaries
      .filter(([, c]) => !calls.some((x) => x.file === c.file && x.method === c.method && x.path === c.path))
      .map(([shape, c]) => `${shape}: ${c.method} ${c.path} (${c.file})`);
    // If one of these legitimately moved, point the canary at another call of
    // the same shape — do not delete it, or that shape stops being checked.
    expect(missing).toEqual([]);
  });

  it('the parameter matcher is strict about segment count', () => {
    // Guards `reaches` itself: without the length check, every path would
    // match a one-segment route and the whole suite would pass vacuously.
    const route = { method: 'GET', path: '/api/subscribers/:imsi' };
    expect(reaches({ file: 'x', method: 'GET', path: '/api/subscribers/001010000000001' }, route)).toBe(true);
    expect(reaches({ file: 'x', method: 'GET', path: '/api/subscribers' }, route)).toBe(false);
    expect(reaches({ file: 'x', method: 'GET', path: '/api/subscribers/1/sessions' }, route)).toBe(false);
    expect(reaches({ file: 'x', method: 'POST', path: '/api/subscribers/1' }, route)).toBe(false);
  });

  it('a trailing * matches the rest of the path, and only below its own prefix', () => {
    // The three admin proxies (vowifi, mms, vectorcore-smsc) are `/admin/*`,
    // and they are how the UI reaches those apps' own REST APIs.
    const route = { method: 'GET', path: '/api/vowifi/admin/*' };
    expect(reaches({ file: 'x', method: 'GET', path: '/api/vowifi/admin/api/v1/status' }, route)).toBe(true);
    expect(reaches({ file: 'x', method: 'GET', path: '/api/vowifi/admin' }, route)).toBe(true);
    expect(reaches({ file: 'x', method: 'GET', path: '/api/vowifi/status' }, route)).toBe(false);
  });
});
