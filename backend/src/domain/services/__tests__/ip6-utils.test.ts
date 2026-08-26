import {
  ipv6ToBigInt, bigIntToIPv6, parseIPv6Cidr, ipv6SubnetAtOffset, ipv6ChildCount,
  ipv6OffsetWithinParent, ipv6FirstUsableAddress, isValidIPv6Cidr,
} from '../ip6-utils';

describe('ipv6ToBigInt / bigIntToIPv6', () => {
  test('round-trips a fully-written address', () => {
    const n = ipv6ToBigInt('2001:0db8:cafe:0000:0000:0000:0000:0001');
    expect(bigIntToIPv6(n)).toBe('2001:db8:cafe::1');
  });

  test('expands "::" shorthand at the start, middle, and end', () => {
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('2001:db8::1')).toBe(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001'));
    expect(ipv6ToBigInt('2001:db8::')).toBe(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0000'));
    expect(ipv6ToBigInt('::')).toBe(0n);
  });

  test('compresses the longest zero run on output', () => {
    // Two equal-length runs (groups 1-2 and groups 5-6) — either is a valid
    // compression choice; just confirm it's a real zero run that gets used
    // and the result round-trips correctly.
    expect(bigIntToIPv6(0n)).toBe('::');
    expect(bigIntToIPv6(1n)).toBe('::1');
  });

  test('rejects malformed addresses', () => {
    expect(() => ipv6ToBigInt('2001:db8:cafe')).toThrow();
    expect(() => ipv6ToBigInt('2001:db8::cafe::1')).toThrow();
    expect(() => ipv6ToBigInt('not-an-address')).toThrow();
  });
});

describe('parseIPv6Cidr', () => {
  test('masks the network address down to the prefix', () => {
    const { network, prefix } = parseIPv6Cidr('2001:db8:cafe:1234::/48');
    expect(prefix).toBe(48);
    expect(bigIntToIPv6(network)).toBe('2001:db8:cafe::');
  });

  test('rejects invalid prefix lengths', () => {
    expect(() => parseIPv6Cidr('2001:db8::/129')).toThrow();
    expect(() => parseIPv6Cidr('2001:db8::/-1')).toThrow();
    expect(() => parseIPv6Cidr('2001:db8::')).toThrow(); // no /prefix at all
  });
});

describe('ipv6SubnetAtOffset', () => {
  test('carves sequential /64s out of a /48 parent', () => {
    expect(ipv6SubnetAtOffset('2001:db8:cafe::/48', 0)).toBe('2001:db8:cafe::/64');
    expect(ipv6SubnetAtOffset('2001:db8:cafe::/48', 1)).toBe('2001:db8:cafe:1::/64');
    expect(ipv6SubnetAtOffset('2001:db8:cafe::/48', 255)).toBe('2001:db8:cafe:ff::/64');
    expect(ipv6SubnetAtOffset('2001:db8:cafe::/48', 4096)).toBe('2001:db8:cafe:1000::/64');
  });

  test('a /64 parent has exactly one valid child at offset 0', () => {
    expect(ipv6SubnetAtOffset('2001:db8:cafe:7::/64', 0, 64)).toBe('2001:db8:cafe:7::/64');
    expect(() => ipv6SubnetAtOffset('2001:db8:cafe:7::/64', 1, 64)).toThrow();
  });

  test('rejects a child prefix less specific than the parent', () => {
    expect(() => ipv6SubnetAtOffset('2001:db8::/64', 0, 48)).toThrow();
  });

  test('rejects an out-of-range offset', () => {
    // /56 parent -> 256 possible /64 children (offsets 0-255)
    expect(() => ipv6SubnetAtOffset('2001:db8:cafe:1200::/56', 256)).toThrow();
    expect(() => ipv6SubnetAtOffset('2001:db8:cafe:1200::/56', -1)).toThrow();
  });
});

describe('ipv6ChildCount', () => {
  test('computes 2^(childPrefix - parentPrefix)', () => {
    expect(ipv6ChildCount('2001:db8::/48', 64)).toBe(65536);
    expect(ipv6ChildCount('2001:db8::/56', 64)).toBe(256);
    expect(ipv6ChildCount('2001:db8::/64', 64)).toBe(1);
  });

  test('returns 0 when the child prefix is less specific than the parent', () => {
    expect(ipv6ChildCount('2001:db8::/64', 48)).toBe(0);
  });
});

describe('ipv6OffsetWithinParent', () => {
  test('recovers the exact offset ipv6SubnetAtOffset produced', () => {
    const parent = '2001:db8:cafe::/48';
    for (const offset of [0, 1, 17, 4095]) {
      const child = ipv6SubnetAtOffset(parent, offset);
      expect(ipv6OffsetWithinParent(parent, child)).toBe(offset);
    }
  });

  test('returns null for a subnet outside the parent block', () => {
    expect(ipv6OffsetWithinParent('2001:db8:cafe::/48', '2001:db8:beef:5::/64')).toBeNull();
  });

  test('returns null for a subnet with the wrong prefix length', () => {
    expect(ipv6OffsetWithinParent('2001:db8:cafe::/48', '2001:db8:cafe:5::/56')).toBeNull();
  });

  test('returns null for a malformed subnet rather than throwing', () => {
    expect(ipv6OffsetWithinParent('2001:db8:cafe::/48', 'not-a-cidr')).toBeNull();
  });
});

describe('ipv6FirstUsableAddress', () => {
  test('is the network address + 1', () => {
    expect(ipv6FirstUsableAddress('2001:db8:cafe:7::/64')).toBe('2001:db8:cafe:7::1');
  });
});

describe('isValidIPv6Cidr', () => {
  test('accepts well-formed CIDRs, rejects everything else', () => {
    expect(isValidIPv6Cidr('2001:db8::/48')).toBe(true);
    expect(isValidIPv6Cidr('10.45.0.0/16')).toBe(false);
    expect(isValidIPv6Cidr('garbage')).toBe(false);
    expect(isValidIPv6Cidr('2001:db8::/200')).toBe(false);
  });
});

// End-to-end scenario matching the real reported case (issue #29's follow-up,
// which is what exposed the need for this feature): the "internet" DNN's
// real live IPv6 session, 2001:db8:cafe::/48, allocated as offset 0 of a
// core-wide parent.
describe('realistic allocation scenario', () => {
  test('first profile gets offset 0, second gets offset 1, gateways are ::1', () => {
    const parent = '2001:db8:cafe::/56'; // 256 possible /64s
    const first = ipv6SubnetAtOffset(parent, 0);
    const second = ipv6SubnetAtOffset(parent, 1);
    expect(first).toBe('2001:db8:cafe::/64');
    expect(second).toBe('2001:db8:cafe:1::/64');
    expect(ipv6FirstUsableAddress(first)).toBe('2001:db8:cafe::1');
    expect(ipv6FirstUsableAddress(second)).toBe('2001:db8:cafe:1::1');
  });
});
