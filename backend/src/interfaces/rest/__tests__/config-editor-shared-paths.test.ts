import * as fs from 'fs';
import * as path from 'path';

/**
 * Nine modules expose a raw config editor (`GET/PUT .../configs/content`).
 * Each declares a manifest of allowlisted host paths, and the PUT writes the
 * submitted content to any allowlisted path VERBATIM -- no merge, and no
 * etag/mtime precondition.
 *
 * That is fine for a file one module owns. It is a hazard for a file TWO
 * modules both offer to edit: the editor shows the whole file and writes back
 * whatever the browser had, so a tab opened before another module added its
 * own line writes a copy that no longer contains it. Nothing warns, and the
 * loss is of the other module's config, not yours -- which is exactly the
 * shape of "I changed something in X and Y broke".
 *
 * These tests freeze that surface. They do NOT claim the overlaps are wrong:
 * all five are real, deliberate, and each is protected by a per-module
 * targeted upsert in normal operation. The point is that the SET is explicit,
 * so a tenth module quietly adding a sixth shared file fails here.
 *
 * Two details make this worth computing rather than eyeballing:
 *
 *  - Paths are declared as string literals, as template literals, and as
 *    module constants, so the manifests must be resolved, not grepped.
 *  - The same host file is addressed both as `/etc/...` and as
 *    `/proc/1/root/etc/...` (the container's view of the host root). Without
 *    normalising that prefix, smf.conf's overlap between OCS and VoWiFi is
 *    INVISIBLE -- it was missed on a first pass over these same manifests for
 *    exactly that reason.
 */

const REST = path.resolve(__dirname, '..');

/** Modules that expose a raw config editor. */
const EDITOR_MODULES = [
  'ims', 'vowifi', 'sms', 'gsm', 'hnbgw', 'ocs', 'pstn', 'asterisk-2g', 'secgw',
] as const;

const read = (mod: string): string =>
  fs.readFileSync(path.join(REST, `${mod}-controller.ts`), 'utf-8');

/** `const NAME = '...'` table for one module, with ${CONST} expanded once. */
export function moduleConstants(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^(?:export )?const ([A-Z_0-9]+)\s*=\s*['"`]([^'"`]*)['"`]/gm)) {
    out[m[1]] = m[2];
  }
  for (const [k, v] of Object.entries(out)) {
    out[k] = v.replace(/\$\{([A-Z_0-9]+)\}/g, (whole, name: string) => out[name] ?? whole);
  }
  return out;
}

/** The container addresses the host root through /proc/1/root; same file. */
export function normalizeHostPath(p: string): string {
  return p.replace(/^\/proc\/1\/root/, '');
}

/** Absolute host paths a module's manifests declare as editable. */
export function declaredPaths(src: string): string[] {
  const consts = moduleConstants(src);
  const found = new Set<string>();
  for (const m of src.matchAll(/path:\s*(?:'([^']+)'|`([^`]+)`|([A-Z_0-9]+))/g)) {
    const raw = m[1] ?? m[2] ?? (m[3] ? consts[m[3]] : undefined);
    if (!raw) continue;
    const resolved = raw.replace(/\$\{([A-Z_0-9]+)\}/g, (whole, n: string) => consts[n] ?? whole);
    if (resolved.startsWith('/') && !resolved.includes('${')) found.add(normalizeHostPath(resolved));
  }
  return [...found].sort();
}

const byPath = (): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const mod of EDITOR_MODULES) {
    for (const p of declaredPaths(read(mod))) {
      m.set(p, [...(m.get(p) ?? []), mod].sort());
    }
  }
  return m;
};

/**
 * Every host file reachable from more than one module's raw config editor,
 * with why it is shared and what keeps the two writers from clobbering each
 * other during NORMAL (non-editor) operation.
 */
const EXPECTED_SHARED: Record<string, { modules: string[]; protectedBy: string }> = {
  '/etc/freeDiameter/smf.conf': {
    modules: ['ocs', 'vowifi'],
    // CLAUDE.md architectural pattern #17: three independently-owned
    // ConnectPeer lines live here -- Gx (core SMF), S6b (VoWiFi's aaa.*) and
    // Gy (OCS's ocs.*) -- and each module's upsert regex-strips ONLY its own
    // naming prefix. OCS's own manifest labels this group "Shared with core
    // SMF / VoWiFi", so the overlap is acknowledged in the code.
    protectedBy: 'prefix-scoped ConnectPeer upserts (aaa.* vs ocs.*)',
  },
  '/etc/osmocom/osmo-hlr.cfg': {
    modules: ['gsm', 'sms'],
    protectedBy: 'vty-config-ownership.ts merge',
  },
  '/etc/osmocom/osmo-msc.cfg': {
    modules: ['gsm', 'sms'],
    protectedBy: 'vty-config-ownership.ts merge',
  },
  '/etc/osmocom/osmo-sgsn.cfg': {
    modules: ['gsm', 'hnbgw'],
    protectedBy: 'vty-config-ownership.ts merge',
  },
  '/etc/osmocom/osmo-stp.cfg': {
    modules: ['gsm', 'sms'],
    protectedBy: 'create-if-absent (gsm) + sms write-once',
  },
};

describe('the resolver itself', () => {
  it('treats /proc/1/root/etc/X and /etc/X as one file', () => {
    // Without this, smf.conf's overlap does not appear at all.
    expect(normalizeHostPath('/proc/1/root/etc/freeDiameter/smf.conf'))
      .toBe('/etc/freeDiameter/smf.conf');
    expect(normalizeHostPath('/etc/freeDiameter/smf.conf'))
      .toBe('/etc/freeDiameter/smf.conf');
  });

  it('leaves a path that merely contains the prefix alone', () => {
    expect(normalizeHostPath('/var/proc/1/root/x')).toBe('/var/proc/1/root/x');
  });

  it('resolves a constant and expands one level of interpolation', () => {
    const src = [
      "const HOST_ROOT = '/proc/1/root';",
      "const A_DIR = `${HOST_ROOT}/etc/thing`;",
      "const A_FILE = `${A_DIR}/a.conf`;",
      "{ path: A_FILE, label: 'a' },",
      "{ path: `${A_DIR}/b.conf`, label: 'b' },",
      "{ path: '/etc/literal.conf', label: 'c' },",
    ].join('\n');
    expect(declaredPaths(src)).toEqual([
      '/etc/literal.conf', '/etc/thing/a.conf', '/etc/thing/b.conf',
    ]);
  });

  it('drops a path it could not fully resolve rather than guessing', () => {
    // Every constant in the nine modules today resolves, so this guard is
    // defensive rather than exercised -- but without a test it is also
    // unverifiable, and a path built from something other than a module
    // constant (a function parameter, say) would otherwise enter the map as
    // the literal text "/etc/${dir}/x" and could collide with itself across
    // modules.
    const src = [
      "const OK = '/etc/real.conf';",
      '{ path: OK, label: \'a\' },',
      '{ path: `/etc/${runtimeDir}/x.conf`, label: \'b\' },',
    ].join('\n');
    expect(declaredPaths(src)).toEqual(['/etc/real.conf']);
  });

  it('finds real paths in every editor module', () => {
    // Guards the whole suite against silently resolving nothing, which would
    // make every overlap assertion below vacuously true.
    for (const mod of EDITOR_MODULES) {
      expect(declaredPaths(read(mod)).length).toBeGreaterThan(0);
    }
  });
});

describe('host files reachable from more than one raw config editor', () => {
  const shared = (): Record<string, string[]> =>
    Object.fromEntries([...byPath()].filter(([, m]) => m.length > 1).sort());

  it('is exactly the known set — a new overlap must be deliberate', () => {
    const expected: Record<string, string[]> = Object.fromEntries(
      Object.entries(EXPECTED_SHARED)
        .map(([p, v]): [string, string[]] => [p, v.modules])
        .sort(),
    );
    expect(shared()).toEqual(expected);
  });

  it('every shared file has a recorded reason it is safe in normal operation', () => {
    for (const [p, mods] of Object.entries(shared())) {
      expect(EXPECTED_SHARED[p]).toBeDefined();
      expect(EXPECTED_SHARED[p].protectedBy.length).toBeGreaterThan(10);
      expect(EXPECTED_SHARED[p].modules).toEqual(mods);
    }
  });

  it('smf.conf is shared by exactly the two prefix-slot owners', () => {
    // The third writer of this file, core SMF via the Open5GS config flow,
    // deliberately does NOT expose it through a raw editor. If it ever did,
    // three editors would offer the same file and this would fail.
    expect(shared()['/etc/freeDiameter/smf.conf']).toEqual(['ocs', 'vowifi']);
  });

  it('the four Osmocom configs are shared only within the 2G/3G family', () => {
    const osmo = Object.entries(shared()).filter(([p]) => p.startsWith('/etc/osmocom/'));
    expect(osmo.length).toBe(4);
    for (const [, mods] of osmo) {
      expect(mods.every((m) => ['gsm', 'sms', 'hnbgw'].includes(m))).toBe(true);
    }
  });
});

describe('what a blind editor write cannot protect', () => {
  it('no editor route takes an etag or mtime precondition', () => {
    // Recorded as the real, accepted limitation rather than asserted as good.
    // A tab opened before another module added its own line writes back a copy
    // without it. The per-module upserts above protect normal operation; they
    // cannot protect a stale editor buffer, because the editor submits the
    // whole file. Closing that needs a precondition on the PUT, which is a
    // behaviour change across nine modules and an operator decision.
    for (const mod of EDITOR_MODULES) {
      const src = read(mod);
      const put = src.slice(src.indexOf("configs/content"));
      expect(put).not.toMatch(/\bif-match\b|\betag\b/i);
    }
  });
});
