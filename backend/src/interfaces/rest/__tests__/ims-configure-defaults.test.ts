import * as fs from 'fs';
import * as path from 'path';
import { IMS_CONFIGURE_DEFAULTS } from '../ims-controller';

const src = fs.readFileSync(path.resolve(__dirname, '../ims-controller.ts'), 'utf-8');

/**
 * Auto-Configuration supplies real addresses from its own allocation but takes
 * the ports and the two loopback CSCF addresses from here. Copying those
 * literals into that path instead is how the two silently drift apart.
 */
describe('IMS_CONFIGURE_DEFAULTS', () => {
  it('holds the values the configure route used before it was extracted', () => {
    // Pinned explicitly: these came from the route's own destructuring
    // defaults, and a silent change to any of them alters what a caller
    // omitting the field gets.
    expect(IMS_CONFIGURE_DEFAULTS).toEqual({
      pcscfIp: '10.0.1.178',
      pcscfPort: 5060,
      icscfIp: '127.0.1.1',
      icscfPort: 4060,
      scscfIp: '127.0.1.2',
      scscfPort: 6060,
      rtpPortMin: 20000,
      rtpPortMax: 30000,
    });
  });

  it('is what the POST /configure route actually destructures from', () => {
    // If the route goes back to inline literals, this feature and the route
    // would default differently for the same deployment.
    // The route aligns its destructuring with padding, so match on the
    // assignment rather than on an exact string.
    for (const field of ['pcscfIp', 'pcscfPort', 'icscfIp', 'icscfPort', 'scscfIp', 'scscfPort', 'rtpPortMin', 'rtpPortMax']) {
      expect(src).toMatch(new RegExp(`${field}\\s*=\\s*IMS_CONFIGURE_DEFAULTS\\.${field}\\b`));
    }
  });

  it('leaves rtpEngineIp and dnsIp OUT, because the route derives them', () => {
    // dnsIp is derived from BIND's own listen-on list, not guessed -- this
    // file's own comment records the real bug where it silently inherited
    // P-CSCF's address instead. A default here would invite that again.
    expect(IMS_CONFIGURE_DEFAULTS).not.toHaveProperty('dnsIp');
    expect(IMS_CONFIGURE_DEFAULTS).not.toHaveProperty('rtpEngineIp');
    expect(src).toContain('rtpEngineIp = pcscfIp');
    expect(src).toContain("dnsIp       = bindListenIp ?? '127.0.0.1'");
  });

  it('keeps the CSCF addresses on loopback', () => {
    // I-CSCF and S-CSCF are internal; only P-CSCF faces the UEs, which is
    // why Auto-Configuration overrides that one and not these.
    expect(IMS_CONFIGURE_DEFAULTS.icscfIp.startsWith('127.')).toBe(true);
    expect(IMS_CONFIGURE_DEFAULTS.scscfIp.startsWith('127.')).toBe(true);
  });
});
