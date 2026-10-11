import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ensureMmeAcceptsUeDetachPeer() appends a ConnectPeer whose identity embeds
// the PLMN. It used to never remove a previous one, so changing MCC/MNC (the
// DNS Migration Wizard, Auto-Config) accreted a stale peer line forever —
// the exact condition CLAUDE.md pattern #13 records as genuinely breaking a
// real Diameter connection. These guard the prefix-scoped cleanup.
//
// HOST_ROOT is baked into the module at import time, so it's pointed at a temp
// dir that mimics /proc/1/root for the duration of the test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uedetach-'));
fs.mkdirSync(path.join(tmp, 'etc/freeDiameter'), { recursive: true });
jest.mock('../twamp/twamp-runner', () => ({ HOST_ROOT: tmp }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureMmeAcceptsUeDetachPeer } = require('../ran/ue-detach-runner');

const CONF = path.join(tmp, 'etc/freeDiameter/mme.conf');
const BASE = `Identity = "mme.epc.mnc001.mcc001.3gppnetwork.org";
Realm = "epc.mnc001.mcc001.3gppnetwork.org";
# all unknown connecting peers are rejected
ConnectPeer = "hss.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };
`;

const peers = (s: string) =>
  s.split('\n').filter(l => /^ConnectPeer/.test(l)).map(l => l.match(/"([^"]+)"/)![1]);

describe('ensureMmeAcceptsUeDetachPeer', () => {
  beforeEach(() => fs.writeFileSync(CONF, BASE, 'utf-8'));

  it('adds the peer after the hss entry and reports a change', () => {
    expect(ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org')).toBe(true);
    const out = fs.readFileSync(CONF, 'utf-8');
    expect(peers(out)).toEqual([
      'hss.epc.mnc001.mcc001.3gppnetwork.org',
      'ue-detach.epc.mnc001.mcc001.3gppnetwork.org',
    ]);
  });

  it('is a genuine no-op on a re-run with the same identity', () => {
    ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org');
    const first = fs.readFileSync(CONF, 'utf-8');
    expect(ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org')).toBe(false);
    expect(fs.readFileSync(CONF, 'utf-8')).toBe(first);
  });

  it('replaces the old PLMN peer instead of accreting a second one', () => {
    ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc070.mcc999.3gppnetwork.org');
    expect(ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org')).toBe(true);
    const out = fs.readFileSync(CONF, 'utf-8');
    expect(peers(out)).toEqual([
      'hss.epc.mnc001.mcc001.3gppnetwork.org',
      'ue-detach.epc.mnc001.mcc001.3gppnetwork.org',
    ]);
    expect(out).not.toContain('mnc070');
  });

  it('never touches another module\'s ConnectPeer lines', () => {
    // VoWiFi's aaa.* and OCS's ocs.* own their own slots (pattern #17).
    fs.writeFileSync(CONF, BASE +
      'ConnectPeer = "aaa.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };\n' +
      'ConnectPeer = "ocs.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };\n', 'utf-8');
    ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org');
    const out = fs.readFileSync(CONF, 'utf-8');
    expect(out).toContain('ConnectPeer = "aaa.epc.mnc001.mcc001.3gppnetwork.org"');
    expect(out).toContain('ConnectPeer = "ocs.epc.mnc001.mcc001.3gppnetwork.org"');
    expect(peers(out)).toHaveLength(4);
  });

  it('appends when there is no hss entry to anchor on, without eating the trailing newline', () => {
    fs.writeFileSync(CONF, 'Identity = "mme";\n', 'utf-8');
    expect(ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org')).toBe(true);
    const out = fs.readFileSync(CONF, 'utf-8');
    expect(out).toBe('Identity = "mme";\nConnectPeer = "ue-detach.epc.mnc001.mcc001.3gppnetwork.org" { No_TLS; };\n');
  });

  it('returns false when mme.conf does not exist at all', () => {
    fs.rmSync(CONF);
    expect(ensureMmeAcceptsUeDetachPeer('ue-detach.epc.mnc001.mcc001.3gppnetwork.org')).toBe(false);
  });
});
