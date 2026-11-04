import * as fs from 'fs';
import * as path from 'path';
import { buildFrrSourceScript, CRASH_GUARD_PATCH_TAG } from '../frr-source-build';

// ── The eigrpd patches must reach every build ────────────────────────────
//
// This file exists because of a specific, repeated failure in this project's
// history, not as a formality. The crash-guard patch sat in the repo for
// months while NO code path applied it, so every "Reinstall" produced a fresh
// UNPATCHED eigrpd and re-armed the crash the patch existed to prevent — and
// the same class of mistake then recurred four more times with the Kamailio
// modules (a fix living in the build script while the deployed artifact
// predated it). A patch is only real if the build applies it.
//
// There are now two eigrpd patches, which is the dangerous number: one applied
// and one forgotten is a state that looks healthy and is not. The
// dangling-adv_router half is the quieter of the two — an unpatched daemon
// does not crash, it installs a gateway-less nexthop and silently blackholes
// part of a prefix.

const PATCH_DIR = path.join(__dirname, '../../../config/frr-patches');

const OPTS = {
  targetTag: CRASH_GUARD_PATCH_TAG,
  snapshotDir: '/opt/frr-build/snap',
  crashGuardPatchPath: '/opt/frr-build/frr-eigrpd-crash-guard.patch',
  extraEigrpdPatchPaths: ['/opt/frr-build/frr-eigrpd-dangling-adv-router.patch'],
};

describe('both patch files are present in the repo', () => {
  test.each([
    'frr-eigrpd-crash-guard.patch',
    'frr-eigrpd-dangling-adv-router.patch',
  ])('%s exists and is a real unified diff', name => {
    const body = fs.readFileSync(path.join(PATCH_DIR, name), 'utf-8');
    expect(body).toMatch(/^diff --git /m);
    expect(body).toMatch(/^@@ /m);
    expect(body.length).toBeGreaterThan(200);
  });

  test('the dangling-adv_router patch touches the files its fix depends on', () => {
    const body = fs.readFileSync(path.join(PATCH_DIR, 'frr-eigrpd-dangling-adv-router.patch'), 'utf-8');
    // eigrp_neighbor.c calls the purge; eigrp_topology.c implements it; and
    // eigrp_zebra.c carries the guard that stops a gateway-less nexthop from
    // being installed at all. Losing any one of the three leaves the fix
    // partially applied, which is harder to spot than no fix.
    for (const f of ['eigrpd/eigrp_neighbor.c', 'eigrpd/eigrp_topology.c', 'eigrpd/eigrp_zebra.c']) {
      expect(body).toContain(f);
    }
  });

  test('the patch introduces the exact marker the deployed-binary check greps for', () => {
    // backup-restart-usecase.ts decides whether a host is patched by looking
    // for this string in /usr/lib/frr/eigrpd. If the patch stops emitting it,
    // that check silently reports every host as unpatched forever.
    const body = fs.readFileSync(path.join(PATCH_DIR, 'frr-eigrpd-dangling-adv-router.patch'), 'utf-8');
    expect(body).toContain('NMS dangling-adv_router');
  });
});

describe('the generated build script applies every patch', () => {
  const script = buildFrrSourceScript(OPTS);

  test('both patch paths are fed to patch(1)', () => {
    expect(script).toContain('patch -p1 --forward -i "/opt/frr-build/frr-eigrpd-crash-guard.patch"');
    expect(script).toContain('patch -p1 --forward -i "/opt/frr-build/frr-eigrpd-dangling-adv-router.patch"');
  });

  test('a missing patch file aborts the build rather than building half-patched', () => {
    // Two guards, one per patch. Counting them is the assertion: a single
    // shared guard would let the second patch go missing unnoticed.
    const guards = script.match(/if \[ ! -f "[^"]*\.patch" \]; then/g) ?? [];
    expect(guards).toHaveLength(2);
    expect(script).toMatch(/exit 1/);
  });

  test('patching happens before configure, so the build compiles patched source', () => {
    const lastPatch = script.lastIndexOf('patch -p1 --forward');
    const configure = script.indexOf('./configure');
    expect(lastPatch).toBeGreaterThan(-1);
    expect(configure).toBeGreaterThan(lastPatch);
  });

  test('an unverified tag skips the patches instead of applying them blind', () => {
    // The diffs are line-number-verified against one FRR release only.
    // Applying them to another tag could succeed against the wrong context.
    const other = buildFrrSourceScript({ ...OPTS, targetTag: 'frr-10.7.0' });
    expect(other).not.toContain('patch -p1 --forward');
    expect(other).toContain('skipping eigrpd patches');
  });

  test('omitting the extra paths still applies the crash-guard one', () => {
    // Backwards compatibility: an older caller that only knows about the
    // crash-guard option must not silently lose it.
    const legacy = buildFrrSourceScript({ ...OPTS, extraEigrpdPatchPaths: undefined });
    expect(legacy).toContain('patch -p1 --forward -i "/opt/frr-build/frr-eigrpd-crash-guard.patch"');
    // Assert on the patch INVOCATION, not on the name appearing anywhere: the
    // abort message names the docs file, so a substring match on
    // "dangling-adv-router" passes against prose and proves nothing. This is
    // the same mistake as an assertion satisfied by a nearby comment.
    expect(legacy).not.toMatch(/patch -p1 --forward -i "[^"]*dangling-adv-router\.patch"/);
    expect((legacy.match(/patch -p1 --forward/g) ?? [])).toHaveLength(1);
  });
});
