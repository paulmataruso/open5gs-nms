import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../ims-controller.ts'), 'utf-8');

/**
 * Comments in this file deliberately quote the OLD, broken shell so the
 * reasoning survives — so an "is the bad pattern gone?" assertion has to look
 * at code only, or it matches the explanation of the bug it is checking for.
 */
const codeOnly = src
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/**
 * Real failure, 2026-11-08, on the second IMS install of a host: all three
 * CSCFs crash-looped with
 *
 *   ksr_version_control(): module version mismatch for cdp.so;
 *   core: kamailio 5.8.8; module: kamailio 5.7.4
 *
 * The step pins its source fetch correctly (`kamailio=$KVER`), but then chose
 * the build tree with `ls -d /tmp/kamailio-*​/src | head -1` — lexical order.
 * With both /tmp/kamailio-5.7.4 (left by another build path, Ubuntu's own
 * version) and /tmp/kamailio-5.8.8+ubuntu24.04 present, it picked 5.7.4 and
 * built cdp.so from the wrong source. Kamailio exits 255 on a version
 * mismatch, so IMS was completely dead — and the FIRST install worked, which
 * is what made it a second-install-only bug.
 */
describe('cdp.so is built from the source matching the installed Kamailio', () => {
  it('does not pick the source tree by lexical order', () => {
    expect(codeOnly).not.toMatch(/ls -d \/tmp\/kamailio-\*\/src[^\n]*head -1/);
  });

  it('selects the tree by the installed version', () => {
    expect(src).toContain('KUPSTREAM=$(echo "$KVER" | sed "s/[+-].*//")');
    expect(src).toMatch(/case "\$d" in \*"\$KUPSTREAM"\*\)/);
  });

  it('clears stale trees before fetching', () => {
    // These are throwaway build trees; leaving one behind is how the wrong
    // one gets chosen.
    expect(src).toMatch(/rm -rf \/tmp\/kamailio-\*/);
  });

  it('fails loudly when no matching tree exists, rather than building something else', () => {
    expect(src).toMatch(/no kamailio source tree matching \$KUPSTREAM/);
  });

  it('REFUSES to deploy a module whose version differs from the core', () => {
    // The invariant that matters regardless of how a wrong tree is chosen.
    expect(src).toContain('BUILT_V=$(strings "$CDP_SO.new"');
    expect(src).toContain('CORE_V=$(kamailio -v');
    expect(src).toMatch(/\[ "\$BUILT_V" != "\$CORE_V" \]/);
    expect(src).toMatch(/Refusing to deploy it/);
  });

  it('removes the rejected artifact instead of leaving it beside the live file', () => {
    const guard = /BUILT_V=\$\(strings[\s\S]*?'fi\\n' \+/.exec(src);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain('rm -f "$CDP_SO.new"');
  });

  it('still deploys by rename, never cp over a live-mapped .so', () => {
    // Pre-existing property that must survive this change: a worker
    // page-faulting into a half-rewritten file dies with SIGILL.
    expect(src).toContain('mv "$CDP_SO.new" "$CDP_SO"');
  });

  it('checks the version BEFORE the rename', () => {
    const buildIdx = src.indexOf('BUILT_V=$(strings "$CDP_SO.new"');
    const mvIdx = src.indexOf('mv "$CDP_SO.new" "$CDP_SO"');
    expect(buildIdx).toBeGreaterThan(-1);
    expect(mvIdx).toBeGreaterThan(buildIdx);
  });
});
