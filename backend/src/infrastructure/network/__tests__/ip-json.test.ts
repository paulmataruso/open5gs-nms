import {
  parseIpAddrShow, ipv4AssignmentsOf, defaultRouteDevice,
  ifaceName, ifaceMac, ifaceState, IpAddrEntry,
} from '../ip-json';

/**
 * The shared reader for iproute2's JSON output, extracted from
 * main-interface.ts and secondary-address.ts (which each walked the same
 * `ip -j addr show` document by hand, both typed `any[]`).
 *
 * The fixture below is this host's real output, trimmed to the fields anything
 * reads — not an invented shape. It is what the narrowing was checked against:
 * every `ifname` a string, every `inet` entry carrying a string `local` and an
 * integer `prefixlen`, and `inet6` entries mixed in among them on the same
 * interface.
 */
const LIVE_ADDR = JSON.stringify([
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
]);

const entry = (over: Partial<IpAddrEntry>): IpAddrEntry => ({ ifname: 'eth0', ...over });

describe('parseIpAddrShow', () => {
  it('reads this host\'s real output', () => {
    const got = parseIpAddrShow(LIVE_ADDR);
    expect(got.map(ifaceName)).toEqual(['lo', 'ens18', 'ens20']);
  });

  it('drops an interface whose ifname is not a string', () => {
    // The reason this exists. Both old copies filtered with
    // `!i.ifname?.startsWith('lo')`, which is TRUE when ifname is absent — so
    // such an entry was kept and then produced `name: undefined` through a
    // field declared `string`.
    const raw = JSON.stringify([{ ifname: 'ens18' }, { operstate: 'UP' }, { ifname: 5 }, { ifname: null }]);
    expect(parseIpAddrShow(raw).map(ifaceName)).toEqual(['ens18']);
  });

  it('returns an empty list for output that is not a JSON array', () => {
    // A tool that printed a message instead of JSON, or an empty capture.
    for (const raw of ['', '   ', 'not json', '{}', 'null', '42', '"ens18"']) {
      expect(parseIpAddrShow(raw)).toEqual([]);
    }
  });

  it('drops a null or scalar array element without throwing', () => {
    expect(parseIpAddrShow('[null, 5, "x", {"ifname":"ens18"}]').map(ifaceName)).toEqual(['ens18']);
  });
});

describe('ifaceMac / ifaceState', () => {
  it('reads the real values', () => {
    const ens18 = parseIpAddrShow(LIVE_ADDR)[1];
    expect(ifaceMac(ens18)).toBe('bc:24:11:07:11:c9');
    expect(ifaceState(ens18)).toBe('UP');
  });

  it('reports null for an absent or non-string field, never "undefined"', () => {
    // A TUN device has no MAC at all, so this is a normal reading rather than
    // a malformed one.
    expect(ifaceMac(entry({}))).toBeNull();
    expect(ifaceState(entry({}))).toBeNull();
    expect(ifaceMac(entry({ address: 42 }))).toBeNull();
    expect(ifaceState(entry({ operstate: {} }))).toBeNull();
  });
});

describe('ipv4AssignmentsOf', () => {
  it('keeps the IPv4 assignment and ignores the IPv6 ones on the same interface', () => {
    const ens18 = parseIpAddrShow(LIVE_ADDR)[1];
    expect(ipv4AssignmentsOf(ens18)).toEqual([{ ip: '172.16.0.168', prefix: 24 }]);
  });

  it('keeps every IPv4 assignment, in order — a secondary address is normal here', () => {
    // Auto-Configuration binds many secondary addresses to one NIC, so the
    // whole list matters, not just the first.
    const got = ipv4AssignmentsOf(entry({ addr_info: [
      { family: 'inet', local: '172.16.0.168', prefixlen: 24 },
      { family: 'inet', local: '172.16.0.31', prefixlen: 24 },
    ] }));
    expect(got).toEqual([{ ip: '172.16.0.168', prefix: 24 }, { ip: '172.16.0.31', prefix: 24 }]);
  });

  it('drops an assignment with a non-string local', () => {
    // What the old `${a.local}/${a.prefixlen}` template turned into the string
    // "undefined/24", and the old `a.local as string` asserted into a string[].
    for (const local of [undefined, null, 42, {}, []]) {
      expect(ipv4AssignmentsOf(entry({ addr_info: [{ family: 'inet', local, prefixlen: 24 }] }))).toEqual([]);
    }
  });

  it('drops an assignment whose prefixlen is not an integer in 0-32', () => {
    // This is the half that protects the CIDR arithmetic downstream: a missing
    // prefixlen used to reach it as NaN and come back out as "172.16.0.93/NaN".
    for (const prefixlen of [undefined, null, '24', 24.5, -1, 33, NaN]) {
      expect(ipv4AssignmentsOf(entry({ addr_info: [{ family: 'inet', local: '10.0.0.1', prefixlen }] }))).toEqual([]);
    }
  });

  it('accepts prefix 0 and prefix 32, the real edges of the range', () => {
    expect(ipv4AssignmentsOf(entry({ addr_info: [{ family: 'inet', local: '0.0.0.0', prefixlen: 0 }] })))
      .toEqual([{ ip: '0.0.0.0', prefix: 0 }]);
    expect(ipv4AssignmentsOf(entry({ addr_info: [{ family: 'inet', local: '10.0.0.1', prefixlen: 32 }] })))
      .toEqual([{ ip: '10.0.0.1', prefix: 32 }]);
  });

  it('drops a local that is a string but not a real dotted quad', () => {
    // The half of the main-interface defect that this boundary closes. A
    // `typeof === 'string'` test is not enough: "10.0.2" is a string, and the
    // private CIDR masking it used to reach turned it into the entirely
    // credible "10.0.2.0/24".
    for (const local of ['', '   ', '10.0.2', '10', 'not-an-ip', '999.1.1.1', '10.0.0.1/24', '1.2.3.4.5']) {
      expect(ipv4AssignmentsOf(entry({ addr_info: [{ family: 'inet', local, prefixlen: 24 }] }))).toEqual([]);
    }
  });

  it('requires family to be exactly inet', () => {
    for (const family of ['inet6', 'INET', undefined, null, 2]) {
      expect(ipv4AssignmentsOf(entry({ addr_info: [{ family, local: '10.0.0.1', prefixlen: 24 }] }))).toEqual([]);
    }
  });

  it('returns an empty list when addr_info is absent, null or not an array', () => {
    // An interface with no address at all is the normal case for a freshly
    // created dummy device.
    expect(ipv4AssignmentsOf(entry({}))).toEqual([]);
    expect(ipv4AssignmentsOf(entry({ addr_info: null }))).toEqual([]);
    expect(ipv4AssignmentsOf(entry({ addr_info: 'x' }))).toEqual([]);
    expect(ipv4AssignmentsOf(entry({ addr_info: {} }))).toEqual([]);
  });

  it('skips a null or scalar addr_info element without throwing', () => {
    const got = ipv4AssignmentsOf(entry({ addr_info: [
      null, 5, { family: 'inet', local: '10.0.0.1', prefixlen: 24 },
    ] }));
    expect(got).toEqual([{ ip: '10.0.0.1', prefix: 24 }]);
  });
});

describe('defaultRouteDevice', () => {
  it('reads this host\'s real default route', () => {
    const raw = JSON.stringify([
      { dst: 'default', gateway: '172.16.0.1', dev: 'ens18', protocol: 'static', flags: [] },
    ]);
    expect(defaultRouteDevice(raw)).toBe('ens18');
  });

  it('is null when there is no default route', () => {
    // A real, supported state: the orchestrator's own "no interface owns the
    // default IPv4 route" branch is what this feeds.
    expect(defaultRouteDevice('[]')).toBeNull();
    expect(defaultRouteDevice('')).toBeNull();
  });

  it('is null for output that is not a JSON array', () => {
    for (const raw of ['not json', '{}', 'null', '5']) {
      expect(defaultRouteDevice(raw)).toBeNull();
    }
  });

  it('skips a route carrying no usable dev and takes the next one', () => {
    const raw = JSON.stringify([
      { dst: 'default', gateway: '10.0.0.1' },
      { dst: 'default', dev: '', gateway: '10.0.0.2' },
      { dst: 'default', dev: 7 },
      { dst: 'default', dev: 'ens19' },
    ]);
    expect(defaultRouteDevice(raw)).toBe('ens19');
  });

  it('is null when every route lacks a dev', () => {
    expect(defaultRouteDevice('[{"dst":"default"},null,5]')).toBeNull();
  });
});
