import { listHostInterfaces, detectMainInterface } from '../main-interface';
import { nsenter } from '../dummy-interface';

jest.mock('../dummy-interface', () => ({ nsenter: jest.fn() }));

const nsenterMock = nsenter as jest.MockedFunction<typeof nsenter>;

/**
 * `detectMainInterface()` is what the IP Plan page displays as the host's
 * network and pre-fills its subnet box with, and what Auto-Configuration
 * picks its interface from.
 *
 * It used to compute that network with a PRIVATE `networkCidr()` — a fifth
 * hand-rolled copy of CIDR masking in this codebase, and the only one with no
 * validation: `ip.split('.').map(Number)` yields `[NaN]` for a malformed
 * address, and JS coerces NaN to 0 through ToInt32 rather than erroring.
 * Measured against the real function before the fix:
 *
 *     not-an-ip     /24   ->  0.0.0.0/24
 *     10.0.2        /24   ->  10.0.2.0/24      <-- plausible, and wrong
 *     172.16.0.93   /NaN  ->  172.16.0.93/NaN
 *
 * The middle one is the dangerous output: a credible-looking network an
 * operator has no way to spot. It is now closed twice over — ip-json drops a
 * malformed assignment at the boundary where the kernel's output arrives, and
 * the arithmetic delegates to ip-utils, which throws. These tests pin both
 * halves, because either one alone would let the defect back in.
 */

/** This host's real `ip -j addr show`, trimmed to the fields anything reads. */
const LIVE_ADDR = [
  { ifname: 'lo', operstate: 'UNKNOWN', address: '00:00:00:00:00:00', addr_info: [
    { family: 'inet', local: '127.0.0.1', prefixlen: 8 },
    { family: 'inet6', local: '::1', prefixlen: 128 },
  ] },
  { ifname: 'ens18', operstate: 'UP', address: 'bc:24:11:07:11:c9', addr_info: [
    { family: 'inet', local: '172.16.0.168', prefixlen: 24 },
    { family: 'inet6', local: 'fe80::be24:11ff:fe07:11c9', prefixlen: 64 },
  ] },
  { ifname: 'ens20', operstate: 'UP', address: 'bc:24:11:2d:21:55', addr_info: [
    { family: 'inet', local: '192.168.253.2', prefixlen: 24 },
  ] },
  { ifname: 'docker0', operstate: 'DOWN', address: '76:3a:23:df:d1:f4', addr_info: [
    { family: 'inet', local: '172.17.0.1', prefixlen: 16 },
  ] },
];

/** This host's real `ip -j route show default`. */
const LIVE_ROUTE = [{ dst: 'default', gateway: '172.16.0.1', dev: 'ens18', protocol: 'static', flags: [] }];

function hostReports(addr: unknown, route: unknown = LIVE_ROUTE): void {
  nsenterMock.mockImplementation((_cmd: string, args: string[] = []) =>
    Promise.resolve({
      stdout: JSON.stringify(args.includes('route') ? route : addr),
      stderr: '',
    }));
}

beforeEach(() => nsenterMock.mockReset());

describe('listHostInterfaces', () => {
  it('reads this host\'s real interfaces and marks the one owning the default route', () => {
    hostReports(LIVE_ADDR);
    return listHostInterfaces().then(({ interfaces, mgmtInterface }) => {
      expect(mgmtInterface).toBe('ens18');
      expect(interfaces.map(i => i.name)).toEqual(['ens18', 'ens20']);
      expect(interfaces[0]).toEqual({
        name: 'ens18',
        mac: 'bc:24:11:07:11:c9',
        state: 'UP',
        addresses: ['172.16.0.168/24'],
        isMgmt: true,
      });
      expect(interfaces[1].isMgmt).toBe(false);
    });
  });

  it('excludes loopback, docker and bridge interfaces', async () => {
    hostReports([...LIVE_ADDR, { ifname: 'br-abc123', addr_info: [] }]);
    const { interfaces } = await listHostInterfaces();
    expect(interfaces.map(i => i.name)).toEqual(['ens18', 'ens20']);
  });

  it('never emits an interface whose name is undefined', async () => {
    // The old filter was `!i.ifname?.startsWith('lo')`, which is TRUE for an
    // entry with no ifname — so it was kept and `name` came out undefined
    // through a field declared `string`, reaching the IP Plan UI's picker.
    hostReports([{ operstate: 'UP', addr_info: [{ family: 'inet', local: '10.0.0.1', prefixlen: 24 }] }, ...LIVE_ADDR]);
    const { interfaces } = await listHostInterfaces();
    expect(interfaces.map(i => i.name)).toEqual(['ens18', 'ens20']);
    for (const i of interfaces) expect(typeof i.name).toBe('string');
  });

  it('reports no addresses rather than "undefined/NaN" for a malformed assignment', async () => {
    hostReports([{ ifname: 'ens18', addr_info: [
      { family: 'inet', prefixlen: 24 },                  // no local
      { family: 'inet', local: '10.0.0.1' },              // no prefixlen
      { family: 'inet', local: '10.0.0.2', prefixlen: 24 },
    ] }]);
    const { interfaces } = await listHostInterfaces();
    expect(interfaces[0].addresses).toEqual(['10.0.0.2/24']);
  });

  it('still lists interfaces when the default-route lookup fails outright', async () => {
    // `ip route show default` exits non-zero on a host with no default route.
    nsenterMock.mockImplementation((_cmd: string, args: string[] = []) =>
      args.includes('route')
        ? Promise.reject(new Error('exit 2'))
        : Promise.resolve({ stdout: JSON.stringify(LIVE_ADDR), stderr: '' }));
    const { interfaces, mgmtInterface } = await listHostInterfaces();
    expect(mgmtInterface).toBeNull();
    expect(interfaces.map(i => i.name)).toEqual(['ens18', 'ens20']);
    expect(interfaces.every(i => i.isMgmt === false)).toBe(true);
  });
});

describe('detectMainInterface', () => {
  it('returns the real network of the interface owning the default route', async () => {
    hostReports(LIVE_ADDR);
    expect(await detectMainInterface()).toEqual({
      name: 'ens18', ip: '172.16.0.168', prefix: 24, cidr: '172.16.0.0/24',
    });
  });

  it('masks a non-zero host part off, on a real /24 and a real /30', async () => {
    // 192.168.253.2 is this deployment's live transit address, which was a /30
    // until the OSPF migration — so both readings are real history here.
    hostReports([{ ifname: 'ens20', addr_info: [{ family: 'inet', local: '192.168.253.2', prefixlen: 24 }] }],
      [{ dev: 'ens20' }]);
    expect((await detectMainInterface())?.cidr).toBe('192.168.253.0/24');

    hostReports([{ ifname: 'ens20', addr_info: [{ family: 'inet', local: '192.168.253.2', prefixlen: 30 }] }],
      [{ dev: 'ens20' }]);
    expect((await detectMainInterface())?.cidr).toBe('192.168.253.0/30');
  });

  it('masks correctly for a first octet >= 128, the signed-int32 trap', async () => {
    // ip-utils' header documents this exact bug class: an unmasked bitwise AND
    // on 192.x produces a corrupted signed value.
    hostReports([{ ifname: 'ens18', addr_info: [{ family: 'inet', local: '192.168.40.77', prefixlen: 20 }] }],
      [{ dev: 'ens18' }]);
    expect((await detectMainInterface())?.cidr).toBe('192.168.32.0/20');
  });

  it('does NOT report a plausible network for a truncated address', async () => {
    // THE DEFECT. `10.0.2` used to come back as the entirely credible
    // `10.0.2.0/24` — and 10.0.2.0/24 is a real prefix on this deployment
    // (the CBRS radio network), so it would have looked right.
    hostReports([{ ifname: 'ens18', addr_info: [{ family: 'inet', local: '10.0.2', prefixlen: 24 }] }],
      [{ dev: 'ens18' }]);
    expect(await detectMainInterface()).toBeNull();
  });

  it('does NOT report 0.0.0.0 for a malformed address', async () => {
    hostReports([{ ifname: 'ens18', addr_info: [{ family: 'inet', local: 'not-an-ip', prefixlen: 24 }] }],
      [{ dev: 'ens18' }]);
    expect(await detectMainInterface()).toBeNull();
  });

  it('does NOT report a /NaN network for a missing prefixlen', async () => {
    hostReports([{ ifname: 'ens18', addr_info: [{ family: 'inet', local: '172.16.0.93' }] }],
      [{ dev: 'ens18' }]);
    expect(await detectMainInterface()).toBeNull();
  });

  it('falls back to the first interface that has an address when no default route exists', async () => {
    hostReports(LIVE_ADDR, []);
    expect(await detectMainInterface()).toEqual({
      name: 'ens18', ip: '172.16.0.168', prefix: 24, cidr: '172.16.0.0/24',
    });
  });

  it('skips an addressless interface when falling back', async () => {
    hostReports([
      { ifname: 'dummy-amf', addr_info: [] },
      { ifname: 'ens20', addr_info: [{ family: 'inet', local: '192.168.253.2', prefixlen: 24 }] },
    ], []);
    expect((await detectMainInterface())?.name).toBe('ens20');
  });

  it('is null when no interface has any IPv4 address', async () => {
    hostReports([{ ifname: 'dummy-amf', addr_info: [{ family: 'inet6', local: '::1', prefixlen: 128 }] }], []);
    expect(await detectMainInterface()).toBeNull();
  });

  it('is null when the host reports nothing parseable at all', async () => {
    nsenterMock.mockImplementation(() => Promise.resolve({ stdout: 'not json', stderr: '' }));
    expect(await detectMainInterface()).toBeNull();
  });
});
