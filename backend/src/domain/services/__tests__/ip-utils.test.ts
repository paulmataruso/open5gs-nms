import { isIpv4, ipToNum, numToIp, cidrRange, cidrNetworkRange, ipv4CidrOverlaps } from '../ip-utils';

/**
 * This module had no tests at all, which is notable given what its own header
 * records: a confirmed live incident on 2026-09-30 where the unvalidated form
 * of `ipToNum`/`parseCidr` let a garbage `"not-a-cidr"` subnet reach
 * smf.yaml/upf.yaml through the real API, because callers wrap these in
 * try/catch specifically to turn a malformed CIDR into a validation error and
 * the throw never fired. These tests pin the throwing, and the signed-int32
 * masking bug the header also documents.
 */

describe('isIpv4', () => {
  it('accepts real addresses from this deployment', () => {
    for (const ip of ['172.16.0.168', '192.168.253.2', '10.0.2.100', '127.0.0.1', '0.0.0.0', '255.255.255.255']) {
      expect(isIpv4(ip)).toBe(true);
    }
  });

  it('rejects an out-of-range octet, which the lax /^\\d{1,3}\\./ copies accept', () => {
    // The reason this is shared rather than another regex: the hand-rolled
    // `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` form elsewhere in this codebase
    // passes all three of these.
    expect(isIpv4('999.1.1.1')).toBe(false);
    expect(isIpv4('256.0.0.1')).toBe(false);
    expect(isIpv4('1.1.1.300')).toBe(false);
  });

  it('rejects a truncated address', () => {
    // The exact value main-interface.ts used to turn into "10.0.2.0/24".
    expect(isIpv4('10.0.2')).toBe(false);
    expect(isIpv4('10')).toBe(false);
    expect(isIpv4('')).toBe(false);
  });

  it('rejects an over-long address, a trailing dot and empty octets', () => {
    expect(isIpv4('1.2.3.4.5')).toBe(false);
    expect(isIpv4('1.2.3.4.')).toBe(false);
    expect(isIpv4('1.2..4')).toBe(false);
    expect(isIpv4('.1.2.3')).toBe(false);
  });

  it('rejects non-numeric text and whitespace', () => {
    for (const ip of ['not-an-ip', 'a.b.c.d', '1.2.3.x', ' 1.2.3.4', '1.2.3.4 ', '1.2.3.-4', '1.2.3.+4']) {
      expect(isIpv4(ip)).toBe(false);
    }
  });

  it('rejects a CIDR — this is an address test, not a prefix test', () => {
    expect(isIpv4('10.0.0.0/24')).toBe(false);
  });
});

describe('ipToNum / numToIp', () => {
  it('round-trips every octet boundary', () => {
    for (const ip of ['0.0.0.0', '0.0.0.1', '10.0.2.100', '172.16.0.168', '192.168.253.2', '255.255.255.255']) {
      expect(numToIp(ipToNum(ip))).toBe(ip);
    }
  });

  it('stays unsigned for a first octet >= 128', () => {
    // The documented footgun: `|` operates on signed Int32, so without the
    // `>>> 0` this returns a negative number and every comparison built on it
    // is wrong.
    expect(ipToNum('192.168.0.1')).toBeGreaterThan(0);
    expect(ipToNum('255.255.255.255')).toBe(4294967295);
    expect(ipToNum('128.0.0.0')).toBe(2147483648);
  });

  it('throws rather than returning 0.0.0.0 for a malformed address', () => {
    // The live incident. `'not-a-cidr'.split('.')` is `['not-a-cidr']`, whose
    // Number() is NaN, which ToInt32 coerces to 0 — so the unvalidated form
    // returned a perfectly usable-looking 0.0.0.0 and the caller's try/catch
    // never fired.
    for (const bad of ['not-a-cidr', '10.0.2', '999.1.1.1', '', '1.2.3.4.5']) {
      expect(() => ipToNum(bad)).toThrow(/Invalid IPv4 address/);
    }
  });
});

describe('cidrNetworkRange', () => {
  it('spans the whole network, including its network and broadcast addresses', () => {
    const r = cidrNetworkRange('10.0.2.0/24');
    expect(numToIp(r.first)).toBe('10.0.2.0');
    expect(numToIp(r.last)).toBe('10.0.2.255');
  });

  it('masks a non-zero host part off', () => {
    // What main-interface.ts now relies on to derive a network from an
    // interface address.
    expect(numToIp(cidrNetworkRange('172.16.0.168/24').first)).toBe('172.16.0.0');
    expect(numToIp(cidrNetworkRange('192.168.253.2/30').first)).toBe('192.168.253.0');
  });

  it('handles a first octet >= 128, the signed-int32 trap in the header', () => {
    const r = cidrNetworkRange('192.168.40.77/20');
    expect(numToIp(r.first)).toBe('192.168.32.0');
    expect(numToIp(r.last)).toBe('192.168.47.255');
  });

  it('handles the /0 and /32 edges', () => {
    const all = cidrNetworkRange('10.0.0.1/0');
    expect(numToIp(all.first)).toBe('0.0.0.0');
    expect(numToIp(all.last)).toBe('255.255.255.255');

    const one = cidrNetworkRange('10.0.0.1/32');
    expect(one.first).toBe(one.last);
    expect(numToIp(one.first)).toBe('10.0.0.1');
  });

  it('defaults a bare address to /32', () => {
    const r = cidrNetworkRange('10.0.0.5');
    expect(r.first).toBe(r.last);
    expect(numToIp(r.first)).toBe('10.0.0.5');
  });

  it('throws rather than inventing an all-ones mask for a bad prefix', () => {
    // The second half of the same live incident: `~0 << (32 - NaN)` coerces to
    // `~0 << 0`, an all-ones /32 mask, instead of erroring.
    for (const bad of ['10.0.0.0/abc', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/2.5', '10.0.0.0/']) {
      expect(() => cidrNetworkRange(bad)).toThrow(/Invalid CIDR prefix/);
    }
  });

  it('throws for a malformed address with a valid prefix', () => {
    expect(() => cidrNetworkRange('not-a-cidr/24')).toThrow(/Invalid IPv4 address/);
  });

  it('throws for a TRAILING-SLASH cidr instead of reading it as the whole internet', () => {
    // The third defect of this file's own documented family, and the one with
    // real teeth. `Number('')` is 0, so "10.45.0.0/" passed every check as
    // prefix 0 and returned a span of 4,294,967,296 addresses — which
    // validation-controller.ts's free-IP-block scan then iterated one at a
    // time, synchronously, wedging the backend's event loop. Whitespace-only
    // prefixes went the same way, since Number(' ') and Number('\n') are 0 too.
    for (const bad of ['10.45.0.0/', '10.0.0.0/ ', '10.0.0.0/\n', '10.0.0.0/\t']) {
      expect(() => cidrNetworkRange(bad)).toThrow(/Invalid CIDR prefix/);
      expect(() => cidrRange(bad)).toThrow(/Invalid CIDR prefix/);
    }
  });

  it('throws for a prefix that is numeric only after coercion', () => {
    // Number('1e1') is 10 and Number('0x10') is 16, both integers in range, so
    // the range check alone accepted them.
    for (const bad of ['10.0.0.0/1e1', '10.0.0.0/0x10', '10.0.0.0/+8', '10.0.0.0/ 8']) {
      expect(() => cidrNetworkRange(bad)).toThrow(/Invalid CIDR prefix/);
    }
  });

  it('throws rather than ignoring everything after a second slash', () => {
    // The destructure silently dropped it, so this read as a clean /24.
    expect(() => cidrNetworkRange('10.0.0.0/24/junk')).toThrow(/Invalid CIDR/);
    expect(() => cidrNetworkRange('10.0.0.0//24')).toThrow(/Invalid CIDR/);
  });
});

describe('cidrRange', () => {
  it('excludes the network and broadcast addresses — host-assignable only', () => {
    const r = cidrRange('10.45.0.0/24');
    expect(numToIp(r.first)).toBe('10.45.0.1');
    expect(numToIp(r.last)).toBe('10.45.0.254');
  });

  it('is the full range minus one at each end, for a /29 SecGW-style block', () => {
    // Auto-Configuration hands each radio one address out of an aligned /29.
    const net = cidrNetworkRange('10.0.3.8/29');
    const host = cidrRange('10.0.3.8/29');
    expect(host.first).toBe(net.first + 1);
    expect(host.last).toBe(net.last - 1);
    expect(numToIp(host.first)).toBe('10.0.3.9');
    expect(numToIp(host.last)).toBe('10.0.3.14');
  });
});

describe('ipv4CidrOverlaps', () => {
  it('reports an overlap when one network contains the other', () => {
    expect(ipv4CidrOverlaps('10.0.0.0/8', '10.45.0.0/16')).toBe(true);
    expect(ipv4CidrOverlaps('10.45.0.0/16', '10.0.0.0/8')).toBe(true);
  });

  it('reports no overlap for the two real UE pools', () => {
    // internet and ims are deliberately disjoint, and a framed route must not
    // be allowed to straddle them.
    expect(ipv4CidrOverlaps('10.45.0.0/16', '10.46.0.0/24')).toBe(false);
  });

  it('reports an overlap for identical networks', () => {
    expect(ipv4CidrOverlaps('10.0.2.0/24', '10.0.2.0/24')).toBe(true);
  });

  it('is exclusive at the boundary — adjacent networks do not overlap', () => {
    // 10.0.2.255 and 10.0.3.0 are adjacent; an off-by-one here would reject
    // every legitimate neighbouring allocation.
    expect(ipv4CidrOverlaps('10.0.2.0/24', '10.0.3.0/24')).toBe(false);
  });

  it('reports an overlap when only the broadcast address is shared', () => {
    // The network and broadcast addresses are INSIDE the compared range, which
    // is why this uses cidrNetworkRange rather than cidrRange.
    expect(ipv4CidrOverlaps('10.0.2.0/24', '10.0.2.255/32')).toBe(true);
    expect(ipv4CidrOverlaps('10.0.2.0/24', '10.0.2.0/32')).toBe(true);
  });

  it('throws for a malformed operand rather than reporting no overlap', () => {
    // Reporting false would silently allow an overlapping framed route.
    expect(() => ipv4CidrOverlaps('not-a-cidr', '10.0.0.0/8')).toThrow();
    expect(() => ipv4CidrOverlaps('10.0.0.0/8', '10.0.0.0/99')).toThrow();
  });
});
