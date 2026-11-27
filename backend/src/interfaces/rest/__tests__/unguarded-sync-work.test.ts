import * as fs from 'fs';
import * as path from 'path';

/**
 * An async route handler that can throw OUTSIDE a try must be wrapped in
 * asyncHandler, or the backend exits.
 *
 * express 4 does not forward a rejected handler promise to its error handler
 * — that arrived in express 5 — and this project is pinned at express 4.22.2
 * with no `unhandledRejection` listener anywhere. So a throw from synchronous
 * code in an `async` handler becomes a floating rejection and node terminates
 * the process. One disk error on one request takes down the whole NMS,
 * including the 16 other NFs' status, every monitor and every running install.
 *
 * Measured when this was written: 434 of the 449 async handlers here already
 * wrap their whole body in try/catch, so this is NOT a widespread defect —
 * it is a short list of specific gaps, which is exactly why a test is the
 * right way to hold it. The 15 found were in backup (mkdirSync for the upload
 * dir), frr (ten handlers calling saveState() or write(), which write
 * /etc/frr/frr.conf — the live routing config), ims (readFileSync in
 * /live/deregister), ocs (resolveActiveRelease() in both /configs/content
 * handlers) and vowifi (unlinkSync in /uninstall).
 *
 * Only ASYNC handlers are checked, and that is the whole point rather than a
 * narrowing: express 4 catches a synchronous throw from a SYNCHRONOUS handler
 * perfectly well — the only thing it fails to forward is a rejected promise.
 * So a handler with nothing to await is better off not being `async` at all
 * than being wrapped (ocs's GET /configs/content is exactly that case), and
 * making one async to "be consistent" would introduce the defect this test
 * exists to prevent.
 *
 * `fs.existsSync` is deliberately NOT in the risky set: it wraps accessSync
 * and returns false rather than throwing, so flagging it would bury the real
 * findings in noise. Everything in RISKY below can genuinely throw on a
 * normal host — EACCES on a root-owned file, ENOSPC, EROFS, EIO, a malformed
 * JSON or YAML file someone hand-edited.
 */

const REST_DIR = path.join(__dirname, '..');

/** Sync calls that throw. Ordered so the regex reads as one group. */
const RISKY = String.raw`(fs\.(readFileSync|writeFileSync|appendFileSync|mkdirSync|readdirSync|statSync|lstatSync|unlinkSync|rmSync|rmdirSync|copyFileSync|renameSync|realpathSync|chmodSync|chownSync)|JSON\.parse|yaml\.load|yaml\.dump|execSync|execFileSync)`;

function stripComments(src: string): string {
  // A comment explaining why some call is guarded contains the call's own
  // name, so counting it as code reports a finding against prose.
  return src.split('\n').map((l) => l.split('//')[0]).join('\n');
}

/** [start, endExclusive] of the braced block whose `{` is at openIdx. */
function block(src: string, openIdx: number): [number, number] {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return [openIdx, i];
    }
  }
  return [openIdx, src.length];
}

/** Regions of `body` that are inside a try block. */
function guardedRegions(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of body.matchAll(/\btry\s*\{/g)) {
    const [, end] = block(body, m.index + m[0].length - 1);
    out.push([m.index, end]);
  }
  return out;
}

interface Finding { file: string; line: number; method: string; route: string; what: string[] }

/**
 * Local helpers that do throwing sync work and guard none of it.
 *
 * One level only, which is the level the real findings were at
 * (`saveState()`, `write()`, `resolveActiveRelease()`). Following the whole
 * call graph would need a type-aware pass; a helper that merely CALLS another
 * unguarded helper is missed, and that limit is stated rather than papered
 * over.
 */
function unguardedHelpers(src: string): Map<string, string> {
  const risky = new RegExp(String.raw`\b${RISKY}\b`, 'g');
  const decl = new RegExp(
    String.raw`(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]`
    + String.raw`|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=>\n]*)?=>`,
    'g',
  );
  const out = new Map<string, string>();
  for (const m of src.matchAll(decl)) {
    const name = m[1] ?? m[2];
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const [s, e] = block(src, open);
    const body = src.slice(s, e);
    // A very long body is a module-level IIFE or a nested router factory
    // rather than a small helper; skipping it keeps this from reporting a
    // whole file as one unguarded function.
    if (body.length > 6000) continue;
    const found = Array.from(new Set(Array.from(body.matchAll(risky), (x) => x[0]))).sort();
    if (found.length > 0 && !/\btry\s*\{/.test(body)) out.set(name, found.join(','));
  }
  return out;
}

function findingsIn(file: string): Finding[] {
  const src = stripComments(fs.readFileSync(path.join(REST_DIR, file), 'utf-8'));
  const helpers = unguardedHelpers(src);
  const risky = new RegExp(String.raw`\b${RISKY}\b`, 'g');
  // The `asyncHandler(` alternative is not optional decoration: once a
  // handler is wrapped, the text between the path and `async` is
  // `, asyncHandler(`, and a regex demanding `,\s*async` stops matching it.
  // Measured: every one of the 15 handlers this test exists for disappeared
  // from the analysis the moment they were fixed, which would have made the
  // assertion below pass for the wrong reason forever.
  const routes = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'[^\n]*?,\s*(?:asyncHandler\(\s*)?async\s*[(<]/g;
  const out: Finding[] = [];
  for (const m of src.matchAll(routes)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const [s, e] = block(src, open);
    const body = src.slice(s, e);
    const guarded = guardedRegions(body);
    const isGuarded = (at: number): boolean => guarded.some(([a, b]) => at >= a && at < b);

    const what: string[] = [];
    for (const x of body.matchAll(risky)) if (!isGuarded(x.index)) what.push(x[0]);
    for (const [name, calls] of helpers) {
      for (const c of body.matchAll(new RegExp(String.raw`\b${name}\s*\(`, 'g'))) {
        if (!isGuarded(c.index)) what.push(`${name}() [${calls}]`);
      }
    }
    if (what.length > 0) {
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        method: m[1].toUpperCase(),
        route: m[2],
        what: Array.from(new Set(what)).sort(),
      });
    }
  }
  return out;
}

function controllerFiles(): string[] {
  return fs.readdirSync(REST_DIR).filter((f) => f.endsWith('-controller.ts')).sort();
}

/** Is this route's handler wrapped so a rejection reaches express's error handler? */
function isWrapped(file: string, method: string, route: string): boolean {
  const src = stripComments(fs.readFileSync(path.join(REST_DIR, file), 'utf-8'));
  const re = new RegExp(
    String.raw`router\.${method.toLowerCase()}\(\s*'${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\n]*?asyncHandler\(`,
  );
  return re.test(src);
}

describe('async handlers that can throw are wrapped', () => {
  const all = controllerFiles().flatMap(findingsIn);

  it('finds the handlers at all — a regex matching nothing would pass everything', () => {
    // The self-guard. Without it a broken route regex reports a clean sweep,
    // which is the failure mode this whole file is designed around.
    const files = controllerFiles();
    expect(files.length).toBeGreaterThan(50);
    const asyncHandlers = files
      .map((f) => stripComments(fs.readFileSync(path.join(REST_DIR, f), 'utf-8')))
      .reduce((n, src) => n + (src.match(/router\.(get|post|put|patch|delete)\(\s*'[^']*'[^\n]*?,\s*(?:asyncHandler\(\s*)?async\s*[(<]/g)?.length ?? 0), 0);
    expect(asyncHandlers).toBeGreaterThan(400);
    // And the analysis must still be able to SEE unguarded work, or the
    // assertion below becomes vacuous the moment the risky regex breaks.
    expect(all.length).toBeGreaterThan(0);
  });

  it('every handler with unguarded throwing work is wrapped in asyncHandler', () => {
    const unprotected = all
      .filter((f) => !isWrapped(f.file, f.method, f.route))
      .map((f) => `${f.file}:${f.line} ${f.method} ${f.route} -> ${f.what.join(', ')}`);
    // On express 4 each of these is a path where one disk error exits the
    // process. Either wrap the handler in asyncHandler, or move the call
    // inside the handler's own try so it answers with a real error.
    expect(unprotected).toEqual([]);
  });

  it('the guarded-region scan actually excludes code inside try', () => {
    // Guards the helper the assertion above depends on: if guardedRegions
    // returned nothing, all 434 already-correct handlers would be reported,
    // and if it returned the whole body, nothing ever would.
    const body = '{ a(); try { b(); } catch { c(); } d(); }';
    const regions = guardedRegions(body);
    expect(regions).toHaveLength(1);
    const [start, end] = regions[0];
    expect(body.slice(start, end)).toContain('b()');
    expect(body.slice(start, end)).not.toContain('a()');
    expect(body.slice(start, end)).not.toContain('d()');
  });

  it('existsSync is not treated as throwing', () => {
    // It wraps accessSync and returns false. Flagging it would bury the real
    // findings: it appears in dozens of handlers, almost all correctly.
    expect(new RegExp(RISKY).test('fs.existsSync(p)')).toBe(false);
    expect(new RegExp(RISKY).test('fs.readFileSync(p)')).toBe(true);
  });

  it('a helper is only called unguarded when the call site is outside try', () => {
    // The ocs case in miniature, and its mirror. Pins that the helper arm of
    // the analysis keys off the CALL SITE's position, not the helper's own.
    const bad = `
      function readRelease(): string { return fs.readFileSync('/x', 'utf-8'); }
      export function make() {
        const router = Router();
        router.get('/a', async (req, res) => {
          const r = readRelease();
          try { res.json({ r }); } catch { res.status(500).end(); }
        });
        router.get('/b', async (req, res) => {
          try { res.json({ r: readRelease() }); } catch { res.status(500).end(); }
        });
        return router;
      }`;
    const tmp = path.join(REST_DIR, '__tmp-fixture-controller.ts');
    fs.writeFileSync(tmp, bad, 'utf-8');
    try {
      const found = findingsIn('__tmp-fixture-controller.ts');
      expect(found.map((f) => f.route)).toEqual(['/a']);
      expect(found[0].what).toEqual(['readRelease() [fs.readFileSync]']);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
