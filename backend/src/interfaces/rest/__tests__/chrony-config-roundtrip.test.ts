import * as fs from 'fs';
import * as path from 'path';
import { parseConfig, serializeConfig } from '../chrony-controller';

/**
 * Round-trip fidelity for /etc/chrony/chrony.conf.
 *
 * WHY THIS SHAPE. chrony.conf is the single source of truth for this module --
 * there is no Mongo mirror, deliberately, the same choice the DHCP module
 * makes for kea-dhcp4.conf. That makes parseConfig/serializeConfig a true
 * round-trip pair, and the question worth testing is not "does it return a
 * string" but "does a save through the UI reproduce the operator's file".
 * Neither function had a single test before this.
 *
 * VERIFIED AGAINST THE LIVE HOST, 2026-11-28. chrony was active, serving time
 * to the RAN (`allow` is set). serializeConfig(parseConfig(live)) is
 * BYTE-IDENTICAL to this host's real /etc/chrony/chrony.conf, and the golden
 * below is that output. The round-trip is also a fixed point: feeding its own
 * output back through gives the same bytes again.
 *
 * TWO REAL DEFECTS WERE FOUND WRITING IT, both fixed in this change, and both
 * invisible to any test that only checked a save succeeded.
 *
 * 1. `local stratum N` ALWAYS parsed back as 10. The branch matched on
 *    startsWith('stratum'), which finds the keyword rather than its value, so
 *    stripping it left '' and parseInt('') -> NaN fell through `|| 10`. The
 *    Time Server page has a stratum field, so saving 5 wrote `local stratum 5`
 *    correctly and the next read showed 10 -- the setting reverted on the
 *    following save, with nothing logged.
 *
 * 2. Every directive this module does not model was DELETED by the next save,
 *    measured at 15 real ones. `refclock` is the one that matters: on a
 *    deployment where chrony serves time to the RAN, an unrelated edit on the
 *    Time Server page would silently remove a hand-configured GPS/PPS
 *    reference clock. They are now carried through verbatim, and the save
 *    route reads them from DISK rather than the request body, because the UI
 *    has no field for them and cannot echo back what it never showed.
 */

const GOLDEN = path.join(__dirname, 'golden', 'chrony', 'chrony.conf');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** This host's real file, as captured 2026-11-28. */
const LIVE = `# /etc/chrony/chrony.conf
# Managed by Open5GS NMS — manual edits will be overwritten on next save

# Upstream time sources
pool ntp.ubuntu.com iburst maxsources 4
pool 0.ubuntu.pool.ntp.org iburst maxsources 1
pool 1.ubuntu.pool.ntp.org iburst maxsources 1
pool 2.ubuntu.pool.ntp.org iburst maxsources 2

# Allow NTP clients
allow 0.0.0.0/0

# Serve time even if upstream sources are temporarily unavailable
local stratum 10

# Keep hardware clock synchronized
rtcsync

# Correct large offsets at startup
makestep 1 3

# Drift file
driftfile /var/lib/chrony/chrony.drift

# Log directory
logdir /var/log/chrony
`;

describe('the live chrony.conf round-trips', () => {
  it('serialize(parse(live)) matches the golden', () => {
    const out = serializeConfig(parseConfig(LIVE));
    if (UPDATE) { fs.writeFileSync(GOLDEN, out, 'utf-8'); return; }
    expect(fs.readFileSync(GOLDEN, 'utf-8')).toBe(out);
  });

  it('and reproduces the live file itself, byte for byte', () => {
    // The strongest statement available here: a save of the unmodified config
    // rewrites the operator's file to exactly what was already there, so
    // opening the page and pressing save is a no-op rather than a reformat.
    expect(serializeConfig(parseConfig(LIVE))).toBe(LIVE);
  });

  it('is a fixed point, not just stable once', () => {
    const once = serializeConfig(parseConfig(LIVE));
    expect(serializeConfig(parseConfig(once))).toBe(once);
  });

  it('keeps a pool a pool, with its own options', () => {
    // pool and server are not interchangeable -- a pool name resolves to
    // several sources and `maxsources` bounds how many are used, so degrading
    // one to a server quietly reduces this host to a single upstream.
    const cfg = parseConfig(LIVE);
    expect(cfg.servers).toHaveLength(4);
    expect(cfg.servers.every((s) => s.type === 'pool')).toBe(true);
    expect(cfg.servers[0]).toEqual({
      type: 'pool', address: 'ntp.ubuntu.com', options: 'iburst maxsources 4',
    });
    // Distinct per-source options, not one value applied to all four.
    expect(cfg.servers.map((s) => s.options)).toEqual([
      'iburst maxsources 4',
      'iburst maxsources 1',
      'iburst maxsources 1',
      'iburst maxsources 2',
    ]);
  });
});

describe('local stratum', () => {
  it('reads the value after the keyword, for every stratum', () => {
    // The regression: each of these used to come back as 10.
    expect(parseConfig('local stratum 5').localStratum).toBe(5);
    expect(parseConfig('local stratum 8').localStratum).toBe(8);
    expect(parseConfig('local stratum 1').localStratum).toBe(1);
    expect(parseConfig('local stratum 10').localStratum).toBe(10);
  });

  it('survives a full save-and-reload cycle', () => {
    // This is the user-visible shape of the bug: the write was always correct,
    // so inspecting the file proved nothing. Only reading it back showed it.
    const saved = serializeConfig({ ...parseConfig(LIVE), localStratum: 5 });
    expect(saved).toContain('local stratum 5');
    expect(parseConfig(saved).localStratum).toBe(5);
  });

  it('still accepts the attached spelling the old code handled', () => {
    expect(parseConfig('local stratum5').localStratum).toBe(5);
  });

  it('defaults to 10 when the directive carries no stratum at all', () => {
    // `local orphan` is valid and sets no stratum; so is a bare `local`.
    expect(parseConfig('local orphan').localStratum).toBe(10);
    expect(parseConfig('local').localStratum).toBe(10);
    expect(parseConfig('').localStratum).toBe(10);
  });

  it('reads the stratum when another option follows it', () => {
    expect(parseConfig('local stratum 8 orphan').localStratum).toBe(8);
  });
});

describe('directives this module does not model', () => {
  /**
   * Real chrony directives absent from ChronyConfig's typed fields. Every one
   * of these was measured to be deleted by a save before this change.
   *
   * The list is the point as much as the assertion: it says which of an
   * operator's lines this NMS is only a custodian of, and the first entry is
   * why the whole thing matters.
   */
  const UNMODELLED = [
    'refclock PPS /dev/pps0 lock NMEA',   // a real GPS/PPS reference clock
    'hwtimestamp *',
    'leapsectz right/UTC',
    'bindaddress 10.0.1.5',
    'port 123',
    'cmdport 0',
    'keyfile /etc/chrony/chrony.keys',
    'initstepslew 30 10.0.1.1',
    'maxupdateskew 100.0',
    'ntsdumpdir /var/lib/chrony',
    'ratelimit interval 1 burst 16',
    'noclientlog',
    'minsources 2',
    'maxdistance 1.0',
    'dumpdir /var/lib/chrony',
  ];

  it('survive a save, verbatim', () => {
    const cfg = parseConfig(`${LIVE}\n${UNMODELLED.join('\n')}\n`);
    expect(cfg.preserved).toEqual(UNMODELLED);
    const saved = serializeConfig(cfg);
    for (const line of UNMODELLED) {
      expect(saved.split('\n').map((l) => l.trim())).toContain(line);
    }
  });

  it('do not accumulate or duplicate across repeated saves', () => {
    // A preserve step that re-reads its own output has to be idempotent, or
    // every visit to the page grows the file.
    const first = serializeConfig(parseConfig(`${LIVE}\nrefclock PPS /dev/pps0 lock NMEA\n`));
    const second = serializeConfig(parseConfig(first));
    expect(second).toBe(first);
    expect(second.match(/^refclock /gm)).toHaveLength(1);
  });

  it('are absent from the config entirely when there are none', () => {
    // The live file has no unmodelled directives, so no header for them may
    // appear -- that is what keeps the byte-identical result above true.
    expect(parseConfig(LIVE).preserved).toBeUndefined();
    expect(serializeConfig(parseConfig(LIVE))).not.toContain('does not manage');
  });

  it('never double-emit a directive the parser DOES model', () => {
    // MODELLED_DIRECTIVES and the parser's own branches have to agree: a
    // keyword missing from the set is parsed into a field AND preserved, so
    // the save writes it twice. Checked behaviourally rather than by reading
    // the set, so it holds whichever one drifts.
    for (const line of [
      'server a.example.com iburst', 'pool b.example.com iburst', 'allow 10.0.0.0/8',
      'local stratum 10', 'makestep 1.0 3', 'rtcsync',
      'driftfile /var/lib/chrony/chrony.drift', 'logdir /var/log/chrony',
    ]) {
      const cfg = parseConfig(line);
      expect(cfg.preserved ?? []).toEqual([]);
      const kw = line.split(/\s+/)[0];
      const emitted = serializeConfig(cfg).split('\n')
        .filter((l) => l.trim().split(/\s+/)[0] === kw);
      expect(emitted).toHaveLength(1);
    }
  });

  it('comments are still dropped, which is a known limit and not a surprise', () => {
    // Stated so the next person does not treat this as a round-trip of the
    // whole FILE. Mapping a comment back to the directive it describes is
    // guesswork, and the generated header says the file is managed.
    const cfg = parseConfig(`${LIVE}\n# operator note: PPS wired to pin 7\nrefclock PPS /dev/pps0\n`);
    expect(cfg.preserved).toEqual(['refclock PPS /dev/pps0']);
    expect(serializeConfig(cfg)).not.toContain('pin 7');
  });
});

describe('the save route takes preserved lines from disk, not the request', () => {
  it('reads the on-disk file and overrides whatever the body carried', () => {
    // The Time Server page has no field for these, so a client round-tripping
    // its own view of the config cannot echo them back -- taking them from the
    // request body would delete them on the first save from the real UI. This
    // is the same reasoning as yaml-config-repository's saveRaw() re-reading
    // from disk before merging.
    const src = fs.readFileSync(path.join(__dirname, '..', 'chrony-controller.ts'), 'utf-8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const put = src.slice(src.indexOf("router.put('/config'"));
    const body = put.slice(0, put.indexOf('auditLogger'));
    expect(body).toMatch(/serializeConfig\(\{\s*\.\.\.cfg,\s*preserved:/);
    expect(body).toMatch(/parseConfig\(fs\.readFileSync\(HOST_CHRONY_CONF/);
  });

  it('a body that omits preserved cannot drop what is on disk', () => {
    // The same merge, exercised rather than read: a client config with no
    // `preserved` key, merged against what the file holds.
    const onDisk = parseConfig(`${LIVE}\nrefclock PPS /dev/pps0\n`).preserved;
    const fromClient = parseConfig(LIVE);
    expect(fromClient.preserved).toBeUndefined();
    expect(serializeConfig({ ...fromClient, preserved: onDisk })).toContain('refclock PPS /dev/pps0');
  });
});
