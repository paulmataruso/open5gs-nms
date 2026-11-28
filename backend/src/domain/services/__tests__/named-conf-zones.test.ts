import {
  upsertNamedZone,
  removeNamedZone,
  removeNamedZonesByPrefix,
  namedZoneBlock,
} from '../named-conf-zones';

/**
 * `named.conf.local` is shared infrastructure: IMS, VoWiFi and the DNS/FQDN
 * Migration Wizard all keep zones in the one file (CLAUDE.md pattern #4).
 *
 * Until this module existed, all three carried a private,
 * character-for-character identical copy of these helpers, and none of them
 * was tested -- so a fix to one would silently not reach the other two. The
 * assertions below are about COEXISTENCE: most would still pass against a
 * function that rewrote the whole file, except the ones checking another
 * module's zones survive. Those are the point.
 */

const IMS_ZONE = 'ims.mnc001.mcc001.3gppnetwork.org';
const EPC_ZONE = 'epc.mnc001.mcc001.3gppnetwork.org';
const VOWIFI_ZONE = 'vowifi.example.net';
const ZONES_DIR = '/etc/bind/zones';

/** A named.conf.local with three modules' zones in it, as a real host has. */
const THREE_MODULES = [
  namedZoneBlock(IMS_ZONE, `${ZONES_DIR}/${IMS_ZONE}.zone`),
  namedZoneBlock(EPC_ZONE, `${ZONES_DIR}/${EPC_ZONE}.zone`),
  namedZoneBlock(VOWIFI_ZONE, `${ZONES_DIR}/${VOWIFI_ZONE}.zone`),
].join('\n');

const zoneNamesIn = (raw: string): string[] =>
  Array.from(raw.matchAll(/zone\s+"([^"]+)"/g), (m) => m[1]);

describe('the stanza this project writes', () => {
  it('is a master zone pointing at its own file', () => {
    expect(namedZoneBlock('a.example', '/etc/bind/zones/a.example.zone')).toBe(
      'zone "a.example" {\n    type master;\n    file "/etc/bind/zones/a.example.zone";\n};\n',
    );
  });
});

describe('upsert leaves the other modules alone', () => {
  it('appends a new zone without disturbing existing ones', () => {
    const out = upsertNamedZone(THREE_MODULES, 'new.example.net', `${ZONES_DIR}/new.zone`);
    expect(zoneNamesIn(out)).toEqual([IMS_ZONE, EPC_ZONE, VOWIFI_ZONE, 'new.example.net']);
  });

  it('replaces only its own stanza when the zone already exists', () => {
    const out = upsertNamedZone(THREE_MODULES, EPC_ZONE, '/srv/moved/epc.zone');
    expect(zoneNamesIn(out)).toEqual([IMS_ZONE, EPC_ZONE, VOWIFI_ZONE]);
    expect(out).toContain('file "/srv/moved/epc.zone";');
    expect(out).not.toContain(`${ZONES_DIR}/${EPC_ZONE}.zone`);
    // The neighbours' file paths are untouched.
    expect(out).toContain(`file "${ZONES_DIR}/${IMS_ZONE}.zone";`);
    expect(out).toContain(`file "${ZONES_DIR}/${VOWIFI_ZONE}.zone";`);
  });

  it('is idempotent — a repeated Configure must not duplicate a stanza', () => {
    // Every module calls this on each Configure, so this runs constantly.
    const once = upsertNamedZone(THREE_MODULES, IMS_ZONE, `${ZONES_DIR}/${IMS_ZONE}.zone`);
    const twice = upsertNamedZone(once, IMS_ZONE, `${ZONES_DIR}/${IMS_ZONE}.zone`);
    expect(twice).toBe(once);
    expect(zoneNamesIn(twice).filter((z) => z === IMS_ZONE).length).toBe(1);
  });

  it('matches the zone name literally, not as a pattern', () => {
    // The dots in a zone name are regex metacharacters, and every zone name
    // here is dotted. Unescaped, "ims.mnc001..." also matches
    // "imsXmnc001..." -- and since the pattern is global, upserting the real
    // zone would collapse BOTH stanzas into one, silently deleting another
    // module's zone.
    //
    // The decoy has to sit alongside the REAL zone for this to bite: upsert
    // guards on a literal raw.includes(), so with the decoy alone it takes the
    // append branch and the pattern never runs at all.
    const raw = [
      namedZoneBlock('imsXmnc001.mcc001.3gppnetwork.org', '/z/decoy.zone'),
      namedZoneBlock(IMS_ZONE, '/z/real.zone'),
    ].join('\n');
    const out = upsertNamedZone(raw, IMS_ZONE, `${ZONES_DIR}/moved.zone`);
    expect(zoneNamesIn(out)).toEqual(['imsXmnc001.mcc001.3gppnetwork.org', IMS_ZONE]);
    expect(out).toContain('/z/decoy.zone');
    expect(out).toContain(`${ZONES_DIR}/moved.zone`);
  });

  it('removes literally too — a dotted name must not eat its neighbour', () => {
    const raw = [
      namedZoneBlock('imsXmnc001.mcc001.3gppnetwork.org', '/z/decoy.zone'),
      namedZoneBlock(IMS_ZONE, '/z/real.zone'),
    ].join('\n');
    // remove has no includes() guard, so the pattern always runs here.
    expect(zoneNamesIn(removeNamedZone(raw, IMS_ZONE)))
      .toEqual(['imsXmnc001.mcc001.3gppnetwork.org']);
  });

  it('rewrites EVERY copy of a duplicated zone, but does not collapse them', () => {
    // Recorded because it is surprising and worth knowing, not because it is
    // desirable. The pattern is global, so upsert replaces each matching
    // stanza with the new block -- which means a file that already held the
    // same zone twice comes back with two identical stanzas, and BIND still
    // refuses to load it. Upsert does NOT heal a duplicate; it only stops
    // creating one (see the idempotency test above). Removing does clear all
    // copies, so remove-then-upsert is the way out.
    //
    // Without the global flag only the first stanza would be rewritten and
    // '/z/second.zone' would survive, which is a strictly worse state: two
    // stanzas for one zone pointing at DIFFERENT files.
    const dup = [
      namedZoneBlock(IMS_ZONE, '/z/first.zone'),
      namedZoneBlock(IMS_ZONE, '/z/second.zone'),
      namedZoneBlock(EPC_ZONE, '/z/epc.zone'),
    ].join('\n');
    const out = upsertNamedZone(dup, IMS_ZONE, '/z/fixed.zone');
    expect(out).not.toContain('/z/first.zone');
    expect(out).not.toContain('/z/second.zone');
    expect((out.match(/\/z\/fixed\.zone/g) ?? []).length).toBe(2);
    // and the unrelated module's zone is untouched
    expect(out).toContain(`zone "${EPC_ZONE}"`);
    expect(out).toContain('/z/epc.zone');
  });

  it('removes every copy of a duplicated zone', () => {
    const dup = [
      namedZoneBlock(IMS_ZONE, '/z/first.zone'),
      namedZoneBlock(IMS_ZONE, '/z/second.zone'),
      namedZoneBlock(EPC_ZONE, '/z/epc.zone'),
    ].join('\n');
    expect(zoneNamesIn(removeNamedZone(dup, IMS_ZONE))).toEqual([EPC_ZONE]);
  });

  it('seeds an empty or comment-only file', () => {
    expect(zoneNamesIn(upsertNamedZone('', 'a.example', '/z/a.zone'))).toEqual(['a.example']);
    const commented = upsertNamedZone('// managed by the NMS\n', 'a.example', '/z/a.zone');
    expect(commented).toContain('// managed by the NMS');
    expect(zoneNamesIn(commented)).toEqual(['a.example']);
  });

  it('does not accumulate blank lines across repeated appends', () => {
    let raw = '';
    for (const z of ['a.example', 'b.example', 'c.example']) {
      raw = upsertNamedZone(raw, z, `/z/${z}.zone`);
    }
    expect(raw).not.toMatch(/\n{3,}/);
  });
});

describe('remove takes one zone and only that zone', () => {
  it('removes the named zone and keeps the rest', () => {
    expect(zoneNamesIn(removeNamedZone(THREE_MODULES, EPC_ZONE))).toEqual([IMS_ZONE, VOWIFI_ZONE]);
  });

  it('is a no-op for a zone that is not there', () => {
    expect(removeNamedZone(THREE_MODULES, 'absent.example.net')).toBe(THREE_MODULES);
  });

  it('round-trips with upsert', () => {
    const added = upsertNamedZone(THREE_MODULES, 'tmp.example.net', '/z/tmp.zone');
    expect(zoneNamesIn(removeNamedZone(added, 'tmp.example.net'))).toEqual(
      [IMS_ZONE, EPC_ZONE, VOWIFI_ZONE],
    );
  });
});

describe('the prefix-wide variant, which an uninstall needs', () => {
  it('removes every zone sharing the prefix, in one pass', () => {
    const many = [
      namedZoneBlock('ims.a.example', '/z/1.zone'),
      namedZoneBlock(EPC_ZONE, '/z/2.zone'),
      namedZoneBlock('ims.b.example', '/z/3.zone'),
      namedZoneBlock(VOWIFI_ZONE, '/z/4.zone'),
    ].join('\n');
    // An uninstall drops all of its own zones without knowing their names.
    expect(zoneNamesIn(removeNamedZonesByPrefix('\n' + many, 'ims.'))).toEqual([
      EPC_ZONE,
      VOWIFI_ZONE,
    ]);
  });

  it('does not touch a zone that merely contains the prefix later in its name', () => {
    const raw = '\n' + [
      namedZoneBlock('ims.a.example', '/z/mine.zone'),
      namedZoneBlock('not-ims.a.example', '/z/theirs.zone'),
    ].join('\n');
    expect(zoneNamesIn(removeNamedZonesByPrefix(raw, 'ims.'))).toEqual(['not-ims.a.example']);
  });

  it('ends with exactly one trailing newline', () => {
    // named.conf.local is appended to repeatedly; a lost or doubled trailing
    // newline is how the next append lands in the wrong place.
    //
    // The input needs trailing slack for this to mean anything -- a file that
    // already ends in exactly one newline makes the normalisation a no-op, so
    // the fixture carries blank lines a real hand-edited file would have.
    const out = removeNamedZonesByPrefix('\n' + THREE_MODULES + '\n\n\n', 'ims.');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(zoneNamesIn(out)).toEqual([EPC_ZONE, VOWIFI_ZONE]);
  });

  it('leaves a file with nothing matching essentially as it was', () => {
    const out = removeNamedZonesByPrefix('\n' + THREE_MODULES, 'nothing-here.');
    expect(zoneNamesIn(out)).toEqual([IMS_ZONE, EPC_ZONE, VOWIFI_ZONE]);
  });
});

describe('the documented limits of these patterns', () => {
  it('handles the flat stanzas every module here emits', () => {
    // Recorded rather than asserted as desirable: the exact-name pattern uses
    // [^}]* and so stops at the first closing brace. Every stanza this project
    // writes is flat (type + file), which is why that is sufficient. This test
    // exists so the limit is visible if a module starts emitting nested options.
    expect(removeNamedZone(namedZoneBlock('a.example', '/z/a.zone'), 'a.example')).toBe('');
  });

  it('tolerates hand-written whitespace and formatting', () => {
    // An operator may have edited this file by hand.
    const hand = 'zone   "a.example"\n{\n  type master;\n  file "/z/a.zone";\n};\n';
    expect(zoneNamesIn(removeNamedZone(hand, 'a.example'))).toEqual([]);
  });
});
