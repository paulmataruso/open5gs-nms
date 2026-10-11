import { upsertVtyDirectives, OwnedDirective } from '../../../domain/services/vty-config-ownership';

// configureSms() accepts hlrBindIp and writes it into osmo-msc.cfg's
// `hlr remote-ip`, but nothing ever wrote osmo-hlr.cfg — so changing it pointed
// MSC at an address OsmoHLR never bound, silently breaking SGs SMS. It now
// merges into the real file. These guard the merge's two requirements: it must
// reach the GSUP bind address (nested one level deeper than upsertVtyDirectives
// normally handles) and it must not destroy the stock file's ussd/logging
// content the way a template overwrite would.

// The real file from this deployment's host, verbatim.
const REAL = `!
! OsmoHLR example configuration
!
log stderr
 logging filter all 1
 logging color 1
 logging print category 1
 logging print category-hex 0
 logging print level 1
 logging level main notice
 logging level db notice
!
line vty
 bind 127.0.0.1
ctrl
 bind 127.0.0.1
hlr
 gsup
  bind ip 127.0.0.1
 ussd route prefix *#100# internal own-msisdn
 ussd route prefix *#101# internal own-imsi
`;

// Mirrors configureSms()'s own construction exactly.
function hlrOwned(cur: string, ip: string): OwnedDirective[] {
  const hasGsup = /^\s*gsup\s*$/m.test(cur);
  return [
    ...(hasGsup || !cur.trim()
      ? [{ node: 'hlr', prefix: /^\s*bind ip\s+/, line: `  bind ip ${ip}` }]
      : []),
    { node: 'ctrl', prefix: /^\s*bind\s+/, line: ` bind ${ip}` },
    { node: 'line vty', prefix: /^\s*bind\s+/, line: ` bind ${ip}` },
  ];
}

const merge = (cur: string, ip: string, fallback = 'FALLBACK') =>
  upsertVtyDirectives(cur, hlrOwned(cur, ip), fallback);

describe('osmo-hlr.cfg ownership merge', () => {
  it('rewrites all three bind addresses in the real host file', () => {
    const out = merge(REAL, '127.0.0.9');
    expect(out).toContain('  bind ip 127.0.0.9');
    expect(out.match(/^ bind 127\.0\.0\.9$/gm)).toHaveLength(2); // line vty + ctrl
    expect(out).not.toContain('127.0.0.1');
  });

  it('preserves the ussd routes and the whole logging block', () => {
    const out = merge(REAL, '127.0.0.9');
    expect(out).toContain(' ussd route prefix *#100# internal own-msisdn');
    expect(out).toContain(' ussd route prefix *#101# internal own-imsi');
    expect(out).toContain(' logging print category-hex 0');
    expect(out).toContain(' logging level db notice');
    expect(out).toContain('! OsmoHLR example configuration');
    // gsup must survive as the parent of bind ip, not be flattened away.
    expect(out).toContain(' gsup\n  bind ip 127.0.0.9');
  });

  it('keeps bind ip INSIDE gsup rather than appending it after the ussd routes', () => {
    const out = merge(REAL, '127.0.0.9');
    const lines = out.split('\n');
    const gsupAt = lines.indexOf(' gsup');
    const bindAt = lines.indexOf('  bind ip 127.0.0.9');
    const firstUssdAt = lines.findIndex(l => l.includes('ussd route'));
    expect(gsupAt).toBeGreaterThan(-1);
    expect(bindAt).toBe(gsupAt + 1);
    expect(bindAt).toBeLessThan(firstUssdAt);
  });

  it('leaves the GSUP bind alone when the file has no gsup block at all', () => {
    // Appending `bind ip` outside gsup would make osmo-hlr reject the config,
    // so that one directive is deliberately skipped here.
    const noGsup = `hlr\n database /var/lib/osmocom/hlr.db\nline vty\n bind 127.0.0.1\n`;
    const out = merge(noGsup, '127.0.0.9');
    expect(out).not.toContain('bind ip');
    expect(out).toContain(' bind 127.0.0.9');
    expect(out).toContain(' database /var/lib/osmocom/hlr.db');
  });

  it('uses the full fallback template only when there is no file yet', () => {
    expect(merge('', '127.0.0.9', 'THE-FALLBACK')).toBe('THE-FALLBACK');
  });

  it('is idempotent — a second merge with the same IP changes nothing', () => {
    const once = merge(REAL, '127.0.0.9');
    expect(merge(once, '127.0.0.9')).toBe(once);
  });
});
