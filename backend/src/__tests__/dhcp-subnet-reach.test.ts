import {
  ipv4ToNum, cidrNumRange, cidrContainsIp, subnetReach, ifaceServesOwnRange, ipInAnyPool,
  type ReachIface,
} from '../../../frontend/src/components/dhcp/subnet-reach';

// The DHCP page's "directly connected / via relay" badge is frontend
// presentation logic, but it is pure and it carries a real claim about Kea's
// behaviour, so it is executed rather than eyeballed. Imported directly because
// the module deliberately has no React or browser dependency — the same
// arrangement as ran/radio-grouping.ts (this project has no frontend runner).

const IFACES: ReachIface[] = [
  { name: 'lo',       cidr: '127.0.0.1/8',       blocked: true  },
  { name: 'ens18',    cidr: '172.16.0.168/24',   blocked: false },
  { name: 'ens20',    cidr: '192.168.253.2/30',  blocked: false },
  { name: 'ogstun',   cidr: '10.45.0.1/24',      blocked: true  },
  { name: 'dummy-up', cidr: null,                blocked: true  },
];

describe('ipv4ToNum', () => {
  test('handles a first octet >= 128 without going negative', () => {
    // The exact footgun CLAUDE.md records against ip-utils.ts: JS bitwise
    // operators are signed Int32, so 192.x without `>>> 0` comes back negative
    // and every range comparison silently inverts.
    expect(ipv4ToNum('192.168.0.1')).toBe(3232235521);
    expect(ipv4ToNum('255.255.255.255')).toBe(4294967295);
    expect(ipv4ToNum('128.0.0.0')).toBe(2147483648);
    expect(ipv4ToNum('0.0.0.0')).toBe(0);
  });

  test('rejects anything that is not a dotted quad', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '1.2.3.256', 'a.b.c.d', '1.2.3.-1', '10.0.0.01x']) {
      expect(ipv4ToNum(bad)).toBeNull();
    }
  });
});

describe('cidrNumRange', () => {
  test('masks a non-canonical network address down to its real base', () => {
    expect(cidrNumRange('192.168.1.77/24')).toEqual({
      first: ipv4ToNum('192.168.1.0')!, last: ipv4ToNum('192.168.1.255')!,
    });
  });

  test('covers the whole space at /0 and a single address at /32', () => {
    expect(cidrNumRange('0.0.0.0/0')).toEqual({ first: 0, last: 4294967295 });
    expect(cidrNumRange('10.1.2.3/32')).toEqual({ first: ipv4ToNum('10.1.2.3')!, last: ipv4ToNum('10.1.2.3')! });
  });

  test('rejects a malformed or out-of-range prefix', () => {
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '10.0.0.0/', 'x/24', '']) {
      expect(cidrNumRange(bad)).toBeNull();
    }
  });
});

describe('cidrContainsIp', () => {
  test('includes the network and broadcast addresses', () => {
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.0')).toBe(true);
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.3')).toBe(true);
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.4')).toBe(false);
  });

  test('false, never a throw, on bad input', () => {
    expect(cidrContainsIp('nonsense', '10.0.0.1')).toBe(false);
    expect(cidrContainsIp('10.0.0.0/8', 'nonsense')).toBe(false);
  });
});

describe('subnetReach', () => {
  test('a subnet containing a usable interface is DIRECT, and names it', () => {
    expect(subnetReach('172.16.0.0/24', IFACES)).toEqual({ kind: 'direct', ifaces: ['ens18'] });
  });

  test('a subnet matching no interface is RELAYED, not an error', () => {
    // The whole point: a remote segment behind a relay is an ordinary subnet.
    expect(subnetReach('203.0.113.0/24', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
  });

  test('a blocked interface never makes a subnet look directly connected', () => {
    // ogstun holds 10.45.0.1 but the UPF owns that range, so a subnet over it
    // must not claim to be locally served.
    expect(subnetReach('10.45.0.0/24', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
  });

  test('an interface with no IPv4 address is ignored rather than throwing', () => {
    expect(subnetReach('0.0.0.0/0', IFACES).ifaces).toEqual(['ens18', 'ens20']);
  });

  test('an incomplete CIDR reads as unknown, so nothing is claimed mid-typing', () => {
    for (const partial of ['', '192.168.', '192.168.50.0', '192.168.50.0/']) {
      expect(subnetReach(partial, IFACES)).toEqual({ kind: 'unknown', ifaces: [] });
    }
  });

  test('a wider subnet can cover several interfaces at once', () => {
    expect(subnetReach('192.0.0.0/2', IFACES)).toEqual({ kind: 'direct', ifaces: ['ens20'] });
  });
});

describe('ifaceServesOwnRange', () => {
  const ens20 = IFACES.find(i => i.name === 'ens20')!;

  test('false when every configured subnet is remote — the relay-only case', () => {
    // This is what keeps "only one address to lease" off a /30 transit
    // interface that exists purely to receive relayed requests.
    expect(ifaceServesOwnRange(ens20, ['203.0.113.0/24', '198.51.100.0/24'])).toBe(false);
  });

  test('true as soon as a subnet covers the interface’s own address', () => {
    expect(ifaceServesOwnRange(ens20, ['203.0.113.0/24', '192.168.253.0/30'])).toBe(true);
  });

  test('false with no subnets at all, and for an interface with no address', () => {
    expect(ifaceServesOwnRange(ens20, [])).toBe(false);
    expect(ifaceServesOwnRange(IFACES.find(i => i.name === 'dummy-up')!, ['0.0.0.0/0'])).toBe(false);
  });
});

// ── ipInAnyPool ───────────────────────────────────────────────────────────
//
// Decides whether pinning a lease as a static binding needs the in-pool
// caution. A dynamic lease is always inside a pool, so the interesting cases
// are the boundaries and the malformed input a hand-rolled split would accept.

describe('ipInAnyPool', () => {
  const POOLS = [{ start: '10.0.2.100', end: '10.0.2.200' }];

  test('inside, and on both inclusive boundaries', () => {
    expect(ipInAnyPool(POOLS, '10.0.2.150')).toBe(true);
    expect(ipInAnyPool(POOLS, '10.0.2.100')).toBe(true);
    expect(ipInAnyPool(POOLS, '10.0.2.200')).toBe(true);
  });

  test('just outside either end', () => {
    expect(ipInAnyPool(POOLS, '10.0.2.99')).toBe(false);
    expect(ipInAnyPool(POOLS, '10.0.2.201')).toBe(false);
  });

  test('any one of several pools is enough', () => {
    const many = [{ start: '10.0.2.10', end: '10.0.2.20' }, ...POOLS];
    expect(ipInAnyPool(many, '10.0.2.15')).toBe(true);
    expect(ipInAnyPool(many, '10.0.2.50')).toBe(false);
  });

  test('no pools means nothing is in a pool', () => {
    expect(ipInAnyPool([], '10.0.2.150')).toBe(false);
  });

  // The reason this is not a split().reduce(): that returns a number for both
  // of these and would place them inside the pool.
  test('malformed addresses are not inside anything', () => {
    expect(ipInAnyPool(POOLS, '10.0.2')).toBe(false);
    expect(ipInAnyPool(POOLS, 'banana')).toBe(false);
    expect(ipInAnyPool(POOLS, '')).toBe(false);
  });

  test('a pool with a malformed bound is skipped, not guessed', () => {
    expect(ipInAnyPool([{ start: '10.0.2.100', end: 'nope' }], '10.0.2.150')).toBe(false);
  });
});
