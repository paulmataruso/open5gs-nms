import {
  allocatePoolAddress, poolCidrHostRange, resolveRemoteTs,
  normalizeCidr, parseExtraLocalCidrs,
} from '../secgw-controller';

/**
 * The per-radio address allocation that keeps two IPsec tunnels from colliding.
 *
 * WHY THIS IS THE PART WORTH TESTING. This module's worst real fault was not a
 * crash: giving several radios the same pool CIDR as their remote_ts made
 * their negotiated CHILD_SAs install the SAME kernel XFRM policy selector,
 * and only one policy can occupy a selector, so whichever radio negotiated
 * most recently silently took it from whoever held it before. The loser still
 * reported ESTABLISHED in swanctl while having no traffic path at all --
 * confirmed by `ip xfrm policy` showing one policy for the shared /29 pointing
 * at one of three "connected" radios. A dedicated single address per radio is
 * what makes the selector unique by construction, so every assertion here is
 * about that uniqueness rather than about the file's text.
 *
 * The generated swanctl conf.d files are deliberately NOT goldened. In PSK
 * mode this module emits a `secrets{}` block into the same file, and the four
 * on this host carry real pre-shared keys, so capturing one would commit a
 * credential. The allocation and traffic-selector logic is pure, which is
 * where the collision lives anyway.
 */

describe('pool CIDR host ranges', () => {
  it('excludes the network and broadcast addresses', () => {
    // A /29 is 8 addresses and 6 usable ones, so the first allocation is .1
    // and never .0, and the last is .6 and never .7.
    // Drained with a hard bound rather than `while (addr !== null)`. An
    // allocator that stops honouring `usedAddresses` returns the same address
    // forever, and an unbounded drain against it HANGS -- which a CI run
    // reports as a timeout rather than as this assertion failing. Found while
    // mutation-testing this very file: the first mutation, removing the
    // used-address check, ran for ten minutes instead of failing in one
    // second. A test for a loop-terminating condition must not itself loop on
    // that condition.
    const all: string[] = [];
    const used = new Set<string>();
    for (let guard = 0; guard < 16; guard++) {
      const a = allocatePoolAddress('10.9.9.0/29', used);
      if (!a) break;
      if (used.has(a)) throw new Error(`reissued ${a} -- allocation ignored usedAddresses`);
      all.push(a);
      used.add(a);
    }
    expect(all).toEqual(['10.9.9.1', '10.9.9.2', '10.9.9.3', '10.9.9.4', '10.9.9.5', '10.9.9.6']);
  });

  it('handles a /30, the smallest pool that can serve a radio at all', () => {
    expect(poolCidrHostRange('192.168.4.0/30')).toEqual({ network: 0xC0A80400, hostCount: 4 });
    const used = new Set<string>();
    expect(allocatePoolAddress('192.168.4.0/30', used)).toBe('192.168.4.1');
    used.add('192.168.4.1');
    expect(allocatePoolAddress('192.168.4.0/30', used)).toBe('192.168.4.2');
    used.add('192.168.4.2');
    expect(allocatePoolAddress('192.168.4.0/30', used)).toBeNull();
  });

  it('rejects a prefix with no room for a usable host', () => {
    // /31 and /32 have no address left once network and broadcast are out, and
    // a pool that cannot serve one radio is a configuration error rather than
    // an empty pool.
    expect(poolCidrHostRange('10.0.0.0/31')).toBeNull();
    expect(poolCidrHostRange('10.0.0.0/32')).toBeNull();
    expect(poolCidrHostRange('10.0.0.0/0')).toBeNull();
    expect(allocatePoolAddress('10.0.0.0/32', new Set())).toBeNull();
  });

  it('masks a pool written with host bits set', () => {
    // An operator may type the address of something inside the range rather
    // than the network address. Both must describe the same pool, or two
    // radios configured at different times get overlapping allocations.
    expect(poolCidrHostRange('10.9.9.5/29')).toEqual(poolCidrHostRange('10.9.9.0/29'));
    expect(allocatePoolAddress('10.9.9.5/29', new Set())).toBe('10.9.9.1');
  });

  it('is correct for a first octet above 127', () => {
    // The documented JS footgun in this codebase: `&` and `|` operate on
    // SIGNED Int32, so any address from 128.0.0.0 up produces a negative
    // number without a `>>> 0`. cidrRange/cidrNetworkRange in ip-utils.ts had
    // exactly this bug and returned corrupted ranges for 192.168.x.x.
    //
    // Measured nuance, worth stating rather than implying more than is true:
    // this path carries FOUR unsigned coercions and any one of them alone is
    // redundant. Removing just the `>>> 0` from ipToInt does not fail this
    // test, because every consumer re-normalises; removing the whole chain
    // does fail it. So what is pinned here is the composite result for a high
    // first octet, not any single coercion -- which is the right granularity,
    // since the realistic regression is a refactor that tidies them all away
    // as noise.
    expect(allocatePoolAddress('192.168.253.0/29', new Set())).toBe('192.168.253.1');
    expect(allocatePoolAddress('172.16.0.0/29', new Set())).toBe('172.16.0.1');
    expect(allocatePoolAddress('240.0.0.0/29', new Set())).toBe('240.0.0.1');
    expect(poolCidrHostRange('192.168.253.0/29')!.network).toBeGreaterThan(0);
    expect(poolCidrHostRange('240.0.0.0/29')!.network).toBeGreaterThan(0);
  });

  it('rejects input that is not a CIDR at all', () => {
    for (const bad of ['', '10.0.0.0', 'not-an-ip/29', '10.0.0.0/', '10.0.0.0/29/29']) {
      expect(poolCidrHostRange(bad)).toBeNull();
    }
  });
});

describe('no two radios are ever given the same address', () => {
  it('skips every address already taken, in any order', () => {
    // The outage invariant. Allocation is driven by a set of addresses read
    // back from the radios already on disk, so it has to be correct for a
    // sparse, arbitrarily-ordered set and not just for a clean run.
    const used = new Set(['10.9.9.1', '10.9.9.3', '10.9.9.4', '10.9.9.6']);
    expect(allocatePoolAddress('10.9.9.0/29', used)).toBe('10.9.9.2');
    used.add('10.9.9.2');
    expect(allocatePoolAddress('10.9.9.0/29', used)).toBe('10.9.9.5');
  });

  it('hands out distinct addresses across a full pool, radio after radio', () => {
    const used = new Set<string>();
    const handed: string[] = [];
    for (let i = 0; i < 14; i++) {
      const a = allocatePoolAddress('10.20.30.0/28', used);
      expect(a).not.toBeNull();
      expect(used.has(a!)).toBe(false);   // never reissued
      used.add(a!);
      handed.push(a!);
    }
    expect(new Set(handed).size).toBe(14);
    // A /28 is 16 addresses, 14 usable, so the pool is now exhausted.
    expect(allocatePoolAddress('10.20.30.0/28', used)).toBeNull();
  });
});

describe('Baicells and Nokia are resolved differently, and must stay that way', () => {
  it('gives a Baicells radio a dedicated pool address, used for both roles', () => {
    // Baicells asks for an address over IKEv2 Configuration Payload, so the
    // address it is offered is also the traffic selector it will present.
    const r = resolveRemoteTs('baicells', '10.0.2.100', '10.9.9.0/29', new Set());
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ poolAddress: '10.9.9.1', remoteTsAddress: '10.9.9.1' });
  });

  it('gives a Nokia radio its OWN real IP, and consumes no pool address', () => {
    // Nokia has no Configuration Payload support at all -- confirmed by
    // reading the radio's own IPsec page, which offers only static tunnel
    // endpoints and traffic selectors. Offering it a pool address meant the
    // CHILD_SA could never negotiate. Consuming one would also waste an
    // address the pool is sized for, so poolAddress must be null rather than
    // merely unused.
    const r = resolveRemoteTs('nokia', '10.0.2.47', '10.9.9.0/29', new Set());
    expect(r).toMatchObject({ poolAddress: null, remoteTsAddress: '10.0.2.47' });
    // And the next Baicells radio still gets the first address in the pool,
    // proving nothing was taken.
    expect(resolveRemoteTs('baicells', null, '10.9.9.0/29', new Set()))
      .toMatchObject({ poolAddress: '10.9.9.1' });
  });

  it('refuses a Nokia radio with no local IP, rather than guessing one', () => {
    const r = resolveRemoteTs('nokia', null, '10.9.9.0/29', new Set());
    expect(r.error).toContain('Local IP Address is required');
    expect(r).toMatchObject({ status: 400 });
    // Specifically not a pool address silently substituted.
    expect((r as { poolAddress?: string }).poolAddress).toBeUndefined();
  });

  it('reports an exhausted pool as a conflict, not as a null address', () => {
    // Returning a null address here would write a conf with an empty
    // remote_ts; the radio is better refused with something an operator can
    // act on.
    const full = new Set(['10.9.9.1', '10.9.9.2']);
    const r = resolveRemoteTs('baicells', null, '10.9.9.0/30', full);
    expect(r).toMatchObject({ status: 409 });
    expect(r.error).toContain('exhausted');
  });

  it('a Nokia radio works with an exhausted pool, because it needs none', () => {
    const full = new Set(['10.9.9.1', '10.9.9.2']);
    expect(resolveRemoteTs('nokia', '10.0.2.47', '10.9.9.0/30', full))
      .toMatchObject({ poolAddress: null, remoteTsAddress: '10.0.2.47' });
  });
});

describe('additional protected destinations', () => {
  it('turns a bare IP into a /32, the common operator entry', () => {
    expect(normalizeCidr('10.0.1.178')).toBe('10.0.1.178/32');
    expect(normalizeCidr('  10.0.1.178  ')).toBe('10.0.1.178/32');
    expect(normalizeCidr('10.0.1.0/24')).toBe('10.0.1.0/24');
  });

  it('distinguishes "nothing given" from "given and invalid"', () => {
    // The distinction is load-bearing: [] means add no extra selectors, null
    // means reject the request. Collapsing them would silently drop an
    // operator's mistyped destination and bring the tunnel up without the
    // route they asked for -- which is the Nokia DNS case this field exists
    // for, so it would look like the radio could not reach BIND.
    expect(parseExtraLocalCidrs(undefined)).toEqual([]);
    expect(parseExtraLocalCidrs(null)).toEqual([]);
    expect(parseExtraLocalCidrs('')).toEqual([]);
    expect(parseExtraLocalCidrs('   ')).toEqual([]);
    expect(parseExtraLocalCidrs(42)).toBeNull();
    expect(parseExtraLocalCidrs(['10.0.0.1'])).toBeNull();
    expect(parseExtraLocalCidrs('10.0.0.1, nonsense')).toBeNull();
  });

  it('parses a comma-separated list, tolerating spacing and empty entries', () => {
    expect(parseExtraLocalCidrs('10.0.1.178, 10.0.2.0/24')).toEqual(['10.0.1.178/32', '10.0.2.0/24']);
    expect(parseExtraLocalCidrs('10.0.1.178,,10.0.2.0/24,')).toEqual(['10.0.1.178/32', '10.0.2.0/24']);
  });

  it('rejects an out-of-range octet or prefix', () => {
    // These used to be accepted: the pattern was \d{1,3} per octet and
    // \d{1,2} for the prefix, so 999.1.1.1 and /99 both passed and were
    // written straight into swanctl.conf, where the CHILD_SA then failed to
    // negotiate for a reason the operator could not see from the UI. The
    // strict check is isIpv4() from domain/services/ip-utils.ts, which this
    // codebase already had and which two other files are noted as needing.
    expect(normalizeCidr('999.1.1.1')).toBeNull();
    expect(normalizeCidr('256.0.0.1')).toBeNull();
    expect(normalizeCidr('10.0.0.1/33')).toBeNull();
    expect(normalizeCidr('10.0.0.1/99')).toBeNull();
    expect(normalizeCidr('10.0.0.1/-1')).toBeNull();
    expect(parseExtraLocalCidrs('10.0.1.178, 999.1.1.1')).toBeNull();
    // Still accepts the real boundaries.
    expect(normalizeCidr('255.255.255.255')).toBe('255.255.255.255/32');
    expect(normalizeCidr('10.0.0.1/0')).toBe('10.0.0.1/0');
    expect(normalizeCidr('10.0.0.1/32')).toBe('10.0.0.1/32');
  });
});
