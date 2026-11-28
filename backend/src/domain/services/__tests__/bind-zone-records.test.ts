import { upsertZoneRecordLine, zoneARecordLine } from '../bind-zone-records';

/**
 * The epc.mnc<mnc>.mcc<mcc>.3gppnetwork.org zone file is shared. The DNS/FQDN
 * Migration Wizard regenerates it wholesale from its own fixed core-17-NF
 * list -- which has no notion of optional add-on modules -- while three
 * modules each merge one record of their own into it: VoWiFi's `aaa`, SecGW's
 * `secgw` and IMS's `ocs`.
 *
 * A merge, never a rewrite, is what lets those three lines survive each
 * other's Configure runs. All three modules carried their own copy of this
 * function and none of them was tested; ims-controller.ts's own comment
 * described the copy chain, so the duplication was known.
 *
 * The coexistence assertions are the point: most of these would still pass
 * against a function that rewrote the file, and those that check the other
 * two modules' records are still present would not.
 */

/** This deployment's real zone file, read from the live host. */
const LIVE = `$TTL 300
$ORIGIN epc.mnc001.mcc001.3gppnetwork.org.

@   IN SOA   ns1 hostmaster (1785697304 3600 1800 604800 300)
@   IN NS    ns1
ns1 IN A     127.0.0.8

hss IN A 127.0.0.8
mme IN A 127.0.0.2
smf IN A 127.0.0.4
pcrf IN A 127.0.0.9
aaa IN A 127.0.0.11
secgw IN A 10.0.1.195
ocs IN A 127.0.1.10
`;

const recordsIn = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/^(\S+)\s+IN\s+A\s+(\S+)\s*$/gm)) out[m[1]] = m[2];
  return out;
};

describe('the record line this project writes', () => {
  it('is name IN A ip', () => {
    expect(zoneARecordLine('aaa', '127.0.0.11')).toBe('aaa IN A 127.0.0.11');
  });
});

describe('three modules sharing one zone file', () => {
  it('replaces only its own record', () => {
    const out = upsertZoneRecordLine(LIVE, 'aaa', '10.20.30.40');
    const recs = recordsIn(out);
    expect(recs.aaa).toBe('10.20.30.40');
    // The other two modules' records are untouched -- the whole point.
    expect(recs.secgw).toBe('10.0.1.195');
    expect(recs.ocs).toBe('127.0.1.10');
    // And so are the core-17 records the migration wizard owns.
    expect(recs.hss).toBe('127.0.0.8');
    expect(recs.mme).toBe('127.0.0.2');
    expect(recs.smf).toBe('127.0.0.4');
    expect(recs.pcrf).toBe('127.0.0.9');
  });

  it('each module\'s upsert leaves the other two intact, in any order', () => {
    let out = LIVE;
    for (const [name, ip] of [['aaa', '10.0.0.1'], ['ocs', '10.0.0.2'], ['secgw', '10.0.0.3']]) {
      out = upsertZoneRecordLine(out, name, ip);
    }
    const recs = recordsIn(out);
    expect(recs.aaa).toBe('10.0.0.1');
    expect(recs.ocs).toBe('10.0.0.2');
    expect(recs.secgw).toBe('10.0.0.3');
    expect(Object.keys(recs).sort())
      .toEqual(['aaa', 'hss', 'mme', 'ns1', 'ocs', 'pcrf', 'secgw', 'smf']);
  });

  it('appends a record that is not there yet', () => {
    const withoutOcs = LIVE.replace('ocs IN A 127.0.1.10\n', '');
    const out = upsertZoneRecordLine(withoutOcs, 'ocs', '127.0.1.10');
    expect(recordsIn(out).ocs).toBe('127.0.1.10');
    // Appending must not disturb what was already there.
    expect(recordsIn(out).secgw).toBe('10.0.1.195');
  });

  it('is idempotent — a repeat Configure changes nothing', () => {
    // Every module calls this on each Configure, and IMS specifically skips
    // its write (and the rndc reload) when the result is unchanged.
    const out = upsertZoneRecordLine(LIVE, 'aaa', '127.0.0.11');
    expect(out).toBe(LIVE);
  });

  it('never leaves two A records for one name', () => {
    // Two A records means round-robin, so half the lookups would return the
    // stale address -- a silent, intermittent failure.
    let out = LIVE;
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      out = upsertZoneRecordLine(out, 'aaa', ip);
    }
    expect((out.match(/^aaa\s+IN\s+A\s+/gm) ?? []).length).toBe(1);
    expect(recordsIn(out).aaa).toBe('10.0.0.3');
  });
});

describe('formatting the real file actually uses', () => {
  it('matches a column-aligned record written by the generator', () => {
    // The wizard's own header records are padded (`ns1 IN A     127.0.0.8`),
    // so the pattern has to tolerate runs of whitespace, not one space.
    const out = upsertZoneRecordLine(LIVE, 'ns1', '127.0.0.99');
    expect(recordsIn(out).ns1).toBe('127.0.0.99');
    expect((out.match(/^ns1\s+IN\s+A\s+/gm) ?? []).length).toBe(1);
  });

  it('keeps the $TTL/$ORIGIN header and the SOA intact', () => {
    const out = upsertZoneRecordLine(LIVE, 'aaa', '10.0.0.1');
    expect(out).toContain('$TTL 300');
    expect(out).toContain('$ORIGIN epc.mnc001.mcc001.3gppnetwork.org.');
    expect(out).toContain('@   IN SOA   ns1 hostmaster (1785697304 3600 1800 604800 300)');
    expect(out).toContain('@   IN NS    ns1');
  });

  it('ends with exactly one newline after an append', () => {
    // A zone file whose last record lacks a trailing newline is a parse error
    // in some BIND versions, and a doubled one accumulates across Configures.
    const out = upsertZoneRecordLine(LIVE.trimEnd(), 'brand-new', '10.0.0.9');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('does not match a record whose name merely ends with the same text', () => {
    // 'cs' must not match 'ocs'. Anchoring is what prevents one module's
    // upsert from rewriting another's record.
    const out = upsertZoneRecordLine(LIVE, 'cs', '10.9.9.9');
    expect(recordsIn(out).ocs).toBe('127.0.1.10');
    expect(recordsIn(out).cs).toBe('10.9.9.9');
  });

  it('treats the record name literally, not as a pattern', () => {
    // The name is interpolated into a RegExp, so it is escaped. No writer here
    // passes a name with metacharacters today; this keeps it safe if one does.
    const raw = 'axc IN A 1.1.1.1\n';
    const out = upsertZoneRecordLine(raw, 'a.c', '2.2.2.2');
    expect(out).toContain('axc IN A 1.1.1.1');
    expect(out).toContain('a.c IN A 2.2.2.2');
  });
});

describe('a documented boundary', () => {
  it('does not recognise a class-less A record, and appends instead', () => {
    // `aaa A 1.2.3.4` is valid zone syntax that this pattern does not match,
    // so the upsert appends a SECOND A record rather than replacing it -- and
    // two A records round-robin. No writer here emits that form, which is why
    // this is recorded rather than handled. If a future writer starts
    // emitting class-less records, this test is where that shows up.
    const raw = 'aaa A 1.2.3.4\n';
    const out = upsertZoneRecordLine(raw, 'aaa', '5.6.7.8');
    expect(out).toContain('aaa A 1.2.3.4');
    expect(out).toContain('aaa IN A 5.6.7.8');
  });
});
