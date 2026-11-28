import * as fs from 'fs';
import * as path from 'path';
import {
  ALL_CONFIG_SERVICES,
  OPEN5GS_DAEMON_SERVICES,
} from '../domain/interfaces/config-repository';

/**
 * "Every Open5GS NF" was written out as a literal list in seven places across
 * six files, and two of them had drifted to sixteen entries by omitting
 * `sepp1`.
 *
 * The omission is invisible from the feature's own side. Syslog forwarding
 * generated a valid rsyslog drop-in, rsyslog validated and reloaded it, and
 * /status reported forwarding as active -- while SEPP's log, 1.0 GB and
 * actively written on this deployment, was never forwarded. Log download
 * offered sixteen files and never reported a seventeenth as missing. Nothing
 * logs, nothing fails, and the only way to notice is to count.
 *
 * backup-restore.ts had already been bitten by exactly this and fixed its own
 * copy, with a comment naming the bug class -- which did not help the two
 * copies in other files that were still wrong. That is the argument for one
 * definition rather than seven correct ones.
 *
 * These tests do three things: pin the membership, pin its relationship to
 * the config-file list it is NOT the same as, and scan the source tree so a
 * re-introduced copy fails here rather than silently going stale.
 */

const SRC_ROOT = path.resolve(__dirname, '..');

/** Every .ts file under src, excluding test files. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the Open5GS NF daemon list', () => {
  it('is the seventeen NFs this project runs as host services', () => {
    // Pinned explicitly: an NF silently leaving this list is the same bug in
    // the other direction, and every consumer below trusts it completely.
    expect([...OPEN5GS_DAEMON_SERVICES].sort()).toEqual([
      'amf', 'ausf', 'bsf', 'hss', 'mme', 'nrf', 'nssf', 'pcf', 'pcrf',
      'scp', 'sepp1', 'sgwc', 'sgwu', 'smf', 'udm', 'udr', 'upf',
    ]);
    expect(OPEN5GS_DAEMON_SERVICES).toHaveLength(17);
  });

  it('has no duplicates', () => {
    expect(new Set(OPEN5GS_DAEMON_SERVICES).size).toBe(OPEN5GS_DAEMON_SERVICES.length);
  });

  it('is the config-file list minus sepp2, and nothing else', () => {
    // The two lists are deliberately different lengths and conflating them is
    // the obvious next mistake: sepp2.yaml is a second N32 peering's CONFIG
    // file, with no open5gs-sepp2d unit and no sepp2.log, so a loop over
    // daemons must not include it while a loop over config files must.
    const configOnly = ALL_CONFIG_SERVICES
      .filter(s => !(OPEN5GS_DAEMON_SERVICES as readonly string[]).includes(s));
    expect(configOnly).toEqual(['sepp2']);

    const daemonOnly = OPEN5GS_DAEMON_SERVICES
      .filter(s => !(ALL_CONFIG_SERVICES as readonly string[]).includes(s));
    expect(daemonOnly).toEqual([]);
  });
});

describe('nothing keeps a second copy of the list', () => {
  // Every duplicate was one ARRAY LITERAL naming the whole set, so that is
  // the unit counted: the innermost [...] spans, scored by how many of the
  // seventeen names each one quotes. A sliding line window was tried first
  // and conflated two adjacent declarations of eleven into one run of
  // fourteen, which would have meant either a useless threshold or adding a
  // legitimate file to the exemptions.
  const THRESHOLD = 13;

  function densestLiteral(src: string): number {
    let worst = 0;
    for (const m of src.matchAll(/\[[^[\]]*\]/g)) {
      // Only a plain list of names counts. apply-config.ts also has a
      // per-NF DISPATCH TABLE -- one row per NF carrying that NF's own typed
      // `saveX` method -- which names all seventeen and is not a duplicated
      // list: it cannot be derived from one without a generic save on
      // IConfigRepository. A span containing a brace or a call is therefore
      // skipped. The cost is that a copy written as an object or a map would
      // not be seen; every copy this found was an array of bare strings.
      if (/[{(]/.test(m[0])) continue;
      const n = OPEN5GS_DAEMON_SERVICES
        .filter(nf => new RegExp(`['"\`]${nf}['"\`]`).test(m[0])).length;
      if (n > worst) worst = n;
    }
    return worst;
  }

  // config-repository.ts holds both lists; that is the point of this test.
  const CANONICAL = path.join(SRC_ROOT, 'domain', 'interfaces', 'config-repository.ts');
  // service-status.ts enumerates every service name as a TYPE union and again
  // as a restart ORDER (which includes mongodb and is deliberately sequenced),
  // so it is a different thing from a membership list and stays as it is.
  const SERVICE_STATUS = path.join(SRC_ROOT, 'domain', 'entities', 'service-status.ts');
  const ALLOWED = new Set([CANONICAL, SERVICE_STATUS]);

  it('finds the canonical definition where it expects it', () => {
    // Guards the scanner itself: if this threshold or the window ever stopped
    // detecting a whole-list literal, every test below would pass vacuously.
    expect(densestLiteral(fs.readFileSync(CANONICAL, 'utf-8'))).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('no other source file writes out most of the list', () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter(f => !ALLOWED.has(f))
      .map(f => ({ file: path.relative(SRC_ROOT, f), n: densestLiteral(fs.readFileSync(f, 'utf-8')) }))
      .filter(({ n }) => n >= THRESHOLD);
    expect(offenders).toEqual([]);
  });

  it('still allows a genuine SUBSET to be written out', () => {
    // Not every list of NFs is this list. The DNS migration wizard's 5GC-only
    // zone membership and pcap's 5GC capture group are real, different sets
    // and must stay literal; the largest sits at eleven, comfortably under
    // the threshold. If a legitimate subset ever grows past it, raise the
    // threshold deliberately rather than adding the file to ALLOWED.
    const subsets = ['application/use-cases/dns-migration-usecase.ts', 'application/use-cases/pcap.ts'];
    for (const rel of subsets) {
      const n = densestLiteral(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8'));
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(THRESHOLD);
    }
  });
});

describe('the consumers that were wrong', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');

  it('syslog forwarding derives its log file list from the shared one', () => {
    // The bug: sixteen inputs, no /var/log/open5gs/sepp1.log, forwarding
    // reported healthy.
    const src = read('interfaces/rest/syslog-controller.ts');
    expect(src).toContain('OPEN5GS_DAEMON_SERVICES');
    expect(src).toMatch(/OPEN5GS_LOG_FILES\s*=\s*OPEN5GS_DAEMON_SERVICES\.map/);
  });

  it('log download derives its service list from the shared one', () => {
    const src = read('interfaces/rest/log-download-controller.ts');
    expect(src).toMatch(/ALL_OPEN5GS_SERVICES[^=]*=\s*OPEN5GS_DAEMON_SERVICES/);
  });

  it('service-controller has one allow-list, not one per route', () => {
    const src = read('interfaces/rest/service-controller.ts');
    // Two routes validated against identical literals, so a name added to one
    // was accepted for status and refused for start/stop.
    expect(src.match(/VALID_SERVICE_NAMES/g) ?? []).toHaveLength(3);
    expect(src).toMatch(/const VALID_SERVICE_NAMES: ServiceName\[\] = \[\s*'mongodb',\s*\.\.\.OPEN5GS_DAEMON_SERVICES,/);
  });
});
