import { describe, it, expect } from 'vitest';
import {
  ipv4ToNum, cidrNumRange, cidrContainsIp, subnetReach, ifaceServesOwnRange, ipInAnyPool,
  type ReachIface,
} from '../subnet-reach';

/**
 * DHCP "directly connected / via relay" classification.
 *
 * Load-bearing facts:
 *  - A subnet with no local interface in range is RELAYED, not an error: Kea
 *    selects the subnet from the relay's giaddr, so a remote segment behind an
 *    `ip helper-address` needs nothing configured locally. Reporting it as a
 *    fault would warn on every healthy remote segment.
 *  - Blocked interfaces (ogstun*, where Open5GS allocates UE addresses itself)
 *    must never make a subnet look locally served.
 *  - First octet >= 128 (192.168.x.x): JS bitwise ops are signed Int32, so a
 *    missing `>>> 0` yields negative numbers and silently wrong ranges.
 *  - ipInAnyPool bounds are inclusive and malformed input is never "in" a pool.
 */

const IFACES: ReachIface[] = [
  { name: 'lo',       cidr: '127.0.0.1/8',      blocked: true  },
  { name: 'ens18',    cidr: '172.16.0.168/24',  blocked: false },
  { name: 'ens20',    cidr: '192.168.253.2/30', blocked: false },
  { name: 'ogstun',   cidr: '10.45.0.1/24',     blocked: true  },
  { name: 'dummy-up', cidr: null,               blocked: true  },
];

describe('ipv4ToNum', () => {
  it('never goes negative for a first octet >= 128', () => {
    expect(ipv4ToNum('192.168.0.1')).toBe(3232235521);
    expect(ipv4ToNum('128.0.0.0')).toBe(2147483648);
    expect(ipv4ToNum('255.255.255.255')).toBe(4294967295);
    expect(ipv4ToNum('0.0.0.0')).toBe(0);
    expect(ipv4ToNum('10.0.0.1')).toBe(167772161);
  });

  it('rejects anything that is not a dotted quad', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '1.2.3.256', 'a.b.c.d', '1.2.3.-1', '10.0.0.01x']) {
      expect(ipv4ToNum(bad)).toBeNull();
    }
  });
});

describe('cidrNumRange', () => {
  it('gives correct ranges for 192.168.x.x subnets', () => {
    expect(cidrNumRange('192.168.1.0/24')).toEqual({ first: 3232235776, last: 3232236031 });
    expect(cidrNumRange('192.168.253.0/30')).toEqual({
      first: ipv4ToNum('192.168.253.0'), last: ipv4ToNum('192.168.253.3'),
    });
    expect(cidrNumRange('128.0.0.0/1')).toEqual({ first: 2147483648, last: 4294967295 });
  });

  it('masks a non-canonical host address down to its base', () => {
    expect(cidrNumRange('192.168.1.77/24')).toEqual({
      first: ipv4ToNum('192.168.1.0'), last: ipv4ToNum('192.168.1.255'),
    });
  });

  it('covers everything at /0 and one address at /32', () => {
    expect(cidrNumRange('0.0.0.0/0')).toEqual({ first: 0, last: 4294967295 });
    const one = ipv4ToNum('203.0.113.9');
    expect(cidrNumRange('203.0.113.9/32')).toEqual({ first: one, last: one });
  });

  it('rejects malformed CIDRs', () => {
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '10.0.0.0/', 'x/24', '', '10.0.0/24']) {
      expect(cidrNumRange(bad)).toBeNull();
    }
  });
});

describe('cidrContainsIp', () => {
  it('includes network and broadcast, excludes neighbours', () => {
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.0')).toBe(true);
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.3')).toBe(true);
    expect(cidrContainsIp('192.168.253.0/30', '192.168.253.4')).toBe(false);
    expect(cidrContainsIp('192.168.253.0/30', '192.168.252.255')).toBe(false);
  });

  it('is correct across the 128 boundary', () => {
    expect(cidrContainsIp('128.0.0.0/1', '200.1.2.3')).toBe(true);
    expect(cidrContainsIp('128.0.0.0/1', '127.255.255.255')).toBe(false);
    expect(cidrContainsIp('0.0.0.0/1', '192.168.0.1')).toBe(false);
  });

  it('returns false rather than throwing on bad input', () => {
    expect(cidrContainsIp('nonsense', '10.0.0.1')).toBe(false);
    expect(cidrContainsIp('10.0.0.0/8', 'nonsense')).toBe(false);
  });
});

describe('subnetReach', () => {
  it('a subnet containing a usable interface is DIRECT and names it', () => {
    expect(subnetReach('172.16.0.0/24', IFACES)).toEqual({ kind: 'direct', ifaces: ['ens18'] });
  });

  it('is DIRECT for a high-first-octet subnet (192.168.253.0/30 holds ens20)', () => {
    expect(subnetReach('192.168.253.0/30', IFACES)).toEqual({ kind: 'direct', ifaces: ['ens20'] });
  });

  it('a subnet with no local interface is RELAYED, not unknown or an error', () => {
    expect(subnetReach('203.0.113.0/24', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
    expect(subnetReach('192.168.99.0/24', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
  });

  it('with no interfaces at all, any valid subnet is relayed', () => {
    expect(subnetReach('10.0.0.0/8', [])).toEqual({ kind: 'relayed', ifaces: [] });
  });

  it('ignores ogstun: its range is never reported as locally served', () => {
    expect(subnetReach('10.45.0.0/24', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
    // and loopback, also blocked
    expect(subnetReach('127.0.0.0/8', IFACES)).toEqual({ kind: 'relayed', ifaces: [] });
  });

  it('skips interfaces with no IPv4 address', () => {
    expect(subnetReach('0.0.0.0/0', IFACES).ifaces).toEqual(['ens18', 'ens20']);
  });

  it('an incomplete CIDR is unknown so nothing is claimed mid-typing', () => {
    for (const partial of ['', '192.168.', '192.168.50.0', '192.168.50.0/', '192.168.50.0/33']) {
      expect(subnetReach(partial, IFACES)).toEqual({ kind: 'unknown', ifaces: [] });
    }
  });
});

describe('ifaceServesOwnRange', () => {
  const ens20 = IFACES.find(i => i.name === 'ens20')!;

  it('false when every subnet is remote (relay-only transit interface)', () => {
    expect(ifaceServesOwnRange(ens20, ['203.0.113.0/24', '198.51.100.0/24'])).toBe(false);
  });

  it('true once any subnet covers the interface address', () => {
    expect(ifaceServesOwnRange(ens20, ['203.0.113.0/24', '192.168.253.0/30'])).toBe(true);
  });

  it('false with no subnets or no interface address', () => {
    expect(ifaceServesOwnRange(ens20, [])).toBe(false);
    expect(ifaceServesOwnRange(IFACES[4], ['0.0.0.0/0'])).toBe(false);
  });
});

describe('ipInAnyPool', () => {
  const POOLS = [{ start: '10.0.2.100', end: '10.0.2.200' }];

  it('is inclusive on both boundaries and true inside', () => {
    expect(ipInAnyPool(POOLS, '10.0.2.100')).toBe(true);
    expect(ipInAnyPool(POOLS, '10.0.2.150')).toBe(true);
    expect(ipInAnyPool(POOLS, '10.0.2.200')).toBe(true);
  });

  it('is false one past either end', () => {
    expect(ipInAnyPool(POOLS, '10.0.2.99')).toBe(false);
    expect(ipInAnyPool(POOLS, '10.0.2.201')).toBe(false);
  });

  it('works for pools with first octet >= 128', () => {
    const hi = [{ start: '192.168.1.10', end: '192.168.1.20' }];
    expect(ipInAnyPool(hi, '192.168.1.10')).toBe(true);
    expect(ipInAnyPool(hi, '192.168.1.21')).toBe(false);
    expect(ipInAnyPool(hi, '10.0.0.15')).toBe(false);
  });

  it('any one of several pools suffices; none means false', () => {
    const many = [{ start: '10.0.2.10', end: '10.0.2.20' }, ...POOLS];
    expect(ipInAnyPool(many, '10.0.2.15')).toBe(true);
    expect(ipInAnyPool(many, '10.0.2.50')).toBe(false);
    expect(ipInAnyPool([], '10.0.2.150')).toBe(false);
  });

  it('malformed addresses are in nothing', () => {
    for (const bad of ['10.0.2', 'banana', '']) expect(ipInAnyPool(POOLS, bad)).toBe(false);
  });

  it('a pool with a malformed bound is skipped', () => {
    expect(ipInAnyPool([{ start: '10.0.2.100', end: 'nope' }], '10.0.2.150')).toBe(false);
    expect(ipInAnyPool([{ start: 'nope', end: '10.0.2.200' }], '10.0.2.150')).toBe(false);
  });
});
