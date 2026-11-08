/**
 * The allocator against a REAL, measured network.
 *
 * These are the addresses actually occupied in 172.16.0.100-.200 on the
 * deployment network this feature was built for, captured by a read-only
 * ping+ARP sweep. A busy subnet is the case that matters — on an empty one
 * the skip logic never runs at all, so a synthetic fixture would pass while
 * the real thing failed.
 */
import {
  buildAutoconfigContext, allocateAddresses, AUTOCONFIG_SERVICES,
} from '../autoconfig-plan';
import { excludeKnownAddresses, ipPlanEntriesFor } from '../autoconfig-apply';

// Measured 2026-11-08. .177 is the test host's own management address.
const OCCUPIED = [
  '172.16.0.100', '172.16.0.111', '172.16.0.114', '172.16.0.119', '172.16.0.130',
  '172.16.0.136', '172.16.0.138', '172.16.0.140', '172.16.0.143', '172.16.0.161',
  '172.16.0.162', '172.16.0.163', '172.16.0.164', '172.16.0.166', '172.16.0.167',
  '172.16.0.177', '172.16.0.178', '172.16.0.180', '172.16.0.181', '172.16.0.182',
  '172.16.0.183', '172.16.0.189', '172.16.0.195', '172.16.0.196', '172.16.0.198',
  '172.16.0.199', '172.16.0.200',
];
const MGMT = '172.16.0.177';

function plan(opts: { skipCheck?: boolean; startIp?: string } = {}) {
  const ctxRes = buildAutoconfigContext({
    enabled: true, interfaceName: 'eth0',
    startIp: opts.startIp ?? '172.16.0.100', gateway: '172.16.0.1', subnet: '255.255.255.0',
    secgwPoolSize: 8, skipIpCheck: !!opts.skipCheck,
  });
  if (!ctxRes.ok) throw new Error(JSON.stringify(ctxRes.errors));
  const ctx = excludeKnownAddresses(ctxRes.context, [MGMT]);
  const res = allocateAddresses(ctx, ip => (opts.skipCheck ? false : OCCUPIED.includes(ip)));
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.plan;
}

describe('allocation on the real network', () => {
  it('skips .100, which is a real third-party device', () => {
    const p = plan();
    expect(p.skipped).toContain('172.16.0.100');
    expect(p.allAddresses).not.toContain('172.16.0.100');
  });

  it('places the ten services on .101 through .110', () => {
    const p = plan();
    expect(p.services.map(s => s.ip)).toEqual([
      '172.16.0.101', '172.16.0.102', '172.16.0.103', '172.16.0.104', '172.16.0.105',
      '172.16.0.106', '172.16.0.107', '172.16.0.108', '172.16.0.109', '172.16.0.110',
    ]);
  });

  it('puts the SecGW pool at .120/29, NOT .112/29', () => {
    // .112-.119 is correctly aligned but contains .114 and .119, both really
    // occupied. A pool expressed as a CIDR covering an occupied address would
    // later hand that address to a radio.
    const p = plan();
    expect(p.secgwPoolCidr).toBe('172.16.0.120/29');
    expect(p.secgwPool).toEqual([
      '172.16.0.120', '172.16.0.121', '172.16.0.122', '172.16.0.123',
      '172.16.0.124', '172.16.0.125', '172.16.0.126', '172.16.0.127',
    ]);
  });

  it('never allocates any really-occupied address', () => {
    const p = plan();
    for (const ip of p.allAddresses) expect(OCCUPIED).not.toContain(ip);
  });

  it('never allocates the gateway', () => {
    expect(plan().allAddresses).not.toContain('172.16.0.1');
  });

  it('never allocates the management address', () => {
    expect(plan().allAddresses).not.toContain(MGMT);
  });

  it('allocates one address per service, all distinct', () => {
    const p = plan();
    expect(p.services).toHaveLength(AUTOCONFIG_SERVICES.length);
    expect(new Set(p.allAddresses).size).toBe(p.allAddresses.length);
  });

  it('maps cleanly onto IP Plan entries, P-CSCF and rtpengine sharing one address', () => {
    const entries = ipPlanEntriesFor(plan());
    const by = new Map(entries.map(e => [e.service, e.ip]));
    expect(by.get('amf-ngap')).toBe('172.16.0.101');
    expect(by.get('ims-pcscf')).toBe('172.16.0.105');
    expect(by.get('ims-rtpengine')).toBe('172.16.0.105');
    expect(by.get('pstn-external-trunk')).toBe('172.16.0.110');
  });

  it('with AUTOCONFIG_SKIP_IP_CHECK, takes .100 even though it is really in use', () => {
    // Exactly what the opt-out means, stated as a test so the risk is not a
    // surprise: the allocation is contiguous from the start address and the
    // real device on .100 is simply ignored.
    const p = plan({ skipCheck: true });
    expect(p.services[0].ip).toBe('172.16.0.100');
    expect(p.skipped).toEqual([]);
    expect(p.secgwPoolCidr).toBe('172.16.0.112/29');
  });

  it('still excludes the management address with the check off', () => {
    // The one protection that must survive the opt-out, since it is a
    // conflict the host told us about rather than one we had to discover.
    //
    // Starts at .175 ON PURPOSE, so .177 is the third address the allocator
    // would reach. Starting at .100 makes this vacuous -- 18 addresses from
    // there never get near .177, so the assertion would hold even with the
    // exclusion removed entirely. (Confirmed: that is exactly what happened,
    // and a mutation test caught it.)
    const p = plan({ skipCheck: true, startIp: '172.16.0.175' });
    expect(p.allAddresses).not.toContain(MGMT);
    // Proves it really did walk through that part of the range.
    expect(p.allAddresses).toContain('172.16.0.175');
    expect(p.allAddresses).toContain('172.16.0.176');
    expect(p.allAddresses).toContain('172.16.0.178');
  });

  it('also excludes the management address when the check is ON', () => {
    const p = plan({ startIp: '172.16.0.175' });
    expect(p.allAddresses).not.toContain(MGMT);
  });
});
