import {
  parseUpstreamResolvers, isLoopbackv4, FALLBACK_RESOLVERS,
} from '../host-resolvers';

/**
 * Real failure on a freshly auto-configured host, 2026-11-08: `docker compose
 * build` died on `lookup registry-1.docker.io on 127.0.0.1:53: server
 * misbehaving`. The module bootstrap points resolv.conf at BIND, Ubuntu ships
 * `forwarders` commented out, and BIND then recurses from the root hints for
 * every external name — which SERVFAILs on a cold cache under parallel load.
 * The same build succeeded once the cache was warm, which is what makes this
 * the nastiest kind of intermittent.
 */
describe('isLoopbackv4', () => {
  it('catches the whole 127/8 block, not just 127.0.0.1', () => {
    // BIND's own loopbacks in this project are spread across 127.0.0.x and
    // 127.0.1.x, and forwarding BIND to any of them is a loop.
    for (const ip of ['127.0.0.1', '127.0.0.53', '127.0.1.10', '127.255.255.255']) {
      expect(isLoopbackv4(ip)).toBe(true);
    }
  });

  it('does not catch ordinary addresses', () => {
    for (const ip of ['172.16.0.50', '8.8.8.8', '10.0.0.1', '12.7.0.0']) {
      expect(isLoopbackv4(ip)).toBe(false);
    }
  });
});

describe('parseUpstreamResolvers', () => {
  // Captured verbatim from the acceptance host.
  const RESOLVED = [
    'nameserver 127.0.0.1',
    'nameserver 172.16.0.50',
    'nameserver 172.16.0.38',
    'nameserver 172.16.0.39',
    'nameserver 2602:f7e3:0:3:b56b:6b42:2160:1966',
    'search dhitechnical.com',
  ].join('\n');
  const LEASE = 'DNS=172.16.0.50 172.16.0.38 172.16.0.39\n';

  it('finds the real upstreams from systemd-resolved output', () => {
    expect(parseUpstreamResolvers([RESOLVED])).toEqual(['172.16.0.50', '172.16.0.38', '172.16.0.39']);
  });

  it('EXCLUDES loopback — forwarding BIND to itself stops resolution entirely', () => {
    // /run/systemd/resolve/resolv.conf genuinely lists 127.0.0.1 once BIND is
    // the system resolver, so this is the normal input, not a contrived one.
    expect(parseUpstreamResolvers([RESOLVED])).not.toContain('127.0.0.1');
  });

  it('EXCLUDES our own allocated addresses, for the same loop reason', () => {
    const out = parseUpstreamResolvers([RESOLVED], ['172.16.0.38', '172.16.0.107']);
    expect(out).toEqual(['172.16.0.50', '172.16.0.39']);
  });

  it('reads a DHCP lease DNS= line', () => {
    expect(parseUpstreamResolvers([LEASE])).toEqual(['172.16.0.50', '172.16.0.38', '172.16.0.39']);
  });

  it('merges several sources without duplicating', () => {
    expect(parseUpstreamResolvers([RESOLVED, LEASE])).toEqual(['172.16.0.50', '172.16.0.38', '172.16.0.39']);
  });

  it('ignores IPv6, because readForwarders() filters to IPv4', () => {
    // A v6 forwarder would be invisible to bind-controller's own reader, so
    // the list would read as empty forever and get rewritten on every run.
    expect(parseUpstreamResolvers([RESOLVED]).some(ip => ip.includes(':'))).toBe(false);
  });

  it('rejects a malformed dotted quad', () => {
    expect(parseUpstreamResolvers(['nameserver 999.1.1.1\nnameserver 10.0.0.1'])).toEqual(['10.0.0.1']);
  });

  it('returns nothing when there is nothing to find', () => {
    expect(parseUpstreamResolvers([])).toEqual([]);
    expect(parseUpstreamResolvers(['search example.com\n# a comment'])).toEqual([]);
  });

  it('preserves the order the host listed them in', () => {
    // The first resolver is the one the operator's DHCP server put first.
    expect(parseUpstreamResolvers(['nameserver 9.9.9.9\nnameserver 1.1.1.1'])).toEqual(['9.9.9.9', '1.1.1.1']);
  });

  it('has a public fallback that is not loopback', () => {
    for (const ip of FALLBACK_RESOLVERS) expect(isLoopbackv4(ip)).toBe(false);
  });
});
