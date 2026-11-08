import {
  probeAddress, probeAddresses, describeProbe, LivenessRunner,
} from '../address-liveness';

const runner = (
  ping: (ip: string) => boolean | Promise<boolean> | never,
  arping: (ip: string) => boolean | Promise<boolean> | never,
): LivenessRunner => ({
  ping: async ip => ping(ip) as boolean,
  arping: async ip => arping(ip) as boolean,
});

describe('probeAddress', () => {
  it('reports free only when BOTH probes are silent', async () => {
    const r = await probeAddress(runner(() => false, () => false), '10.0.0.5');
    expect(r.taken).toBe(false);
    expect(r.via).toBe('none');
  });

  it('reports taken when ping answers', async () => {
    const r = await probeAddress(runner(() => true, () => false), '10.0.0.5');
    expect(r.taken).toBe(true);
    expect(r.via).toBe('icmp');
  });

  it('reports taken when only ARP answers — the case ping alone would MISS', async () => {
    // A host with a firewall dropping ICMP is silent to ping while still
    // owning the address. Ping-only would call this free and we would bind a
    // duplicate, breaking the other host.
    const r = await probeAddress(runner(() => false, () => true), '10.0.0.5');
    expect(r.taken).toBe(true);
    expect(r.via).toBe('arp');
  });

  it('reports both when both answer', async () => {
    const r = await probeAddress(runner(() => true, () => true), '10.0.0.5');
    expect(r.via).toBe('both');
  });

  it('treats a FAILED probe as taken, never as free', async () => {
    // We cannot tell "nothing is there" from "we failed to look", and only one
    // of those is safe to act on.
    const boom = () => { throw new Error('arping: command not found'); };
    const r = await probeAddress(runner(() => false, boom), '10.0.0.5');
    expect(r.taken).toBe(true);
    expect(r.via).toBe('error');
    expect(r.detail).toMatch(/treating as IN USE/);
  });

  it('treats a failure of BOTH probes as taken', async () => {
    const boom = () => { throw new Error('nope'); };
    const r = await probeAddress(runner(boom, boom), '10.0.0.5');
    expect(r.taken).toBe(true);
    expect(r.via).toBe('error');
  });

  it('still trusts a positive answer when the OTHER probe errored', async () => {
    const boom = () => { throw new Error('nope'); };
    const r = await probeAddress(runner(() => true, boom), '10.0.0.5');
    expect(r.taken).toBe(true);
    expect(r.via).toBe('icmp');
  });

  it('runs both probes rather than short-circuiting on the first', async () => {
    // Both signals are recorded so the report can say which saw it.
    const seen: string[] = [];
    await probeAddress(runner(
      () => { seen.push('ping'); return false; },
      () => { seen.push('arp'); return false; },
    ), '10.0.0.5');
    expect(seen).toEqual(['ping', 'arp']);
  });
});

describe('probeAddresses', () => {
  it('probes every address and keys the results by IP', async () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const res = await probeAddresses(runner(ip => ip === '10.0.0.2', () => false), ips);
    expect(res.size).toBe(3);
    expect(res.get('10.0.0.2')?.taken).toBe(true);
    expect(res.get('10.0.0.1')?.taken).toBe(false);
  });

  it('caps concurrency so a wide subnet cannot flood the segment', async () => {
    // Unbounded parallel pings both flood the network the deployment is about
    // to live on and make timeouts unreliable enough to produce a false
    // "free" — the one answer this must never give.
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return false;
    };
    const ips = Array.from({ length: 40 }, (_, i) => `10.0.0.${i + 1}`);
    await probeAddresses({ ping: slow, arping: slow }, ips, 4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list without hanging', async () => {
    const res = await probeAddresses(runner(() => false, () => false), []);
    expect(res.size).toBe(0);
  });

  it('does not lose results when one address errors', async () => {
    const res = await probeAddresses(runner(
      ip => { if (ip === '10.0.0.2') throw new Error('x'); return false; },
      () => false,
    ), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    expect(res.size).toBe(3);
    expect(res.get('10.0.0.2')?.taken).toBe(true);
    expect(res.get('10.0.0.3')?.taken).toBe(false);
  });
});

describe('describeProbe', () => {
  it('says so plainly when everything is free', async () => {
    const res = await probeAddresses(runner(() => false, () => false), ['10.0.0.1', '10.0.0.2']);
    expect(describeProbe(res)).toBe('Probed 2 address(es); all free.');
  });

  it('names each occupied address and which probe saw it', async () => {
    const res = await probeAddresses(runner(ip => ip === '10.0.0.1', ip => ip === '10.0.0.2'),
      ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const out = describeProbe(res);
    expect(out).toMatch(/2 already in use/);
    expect(out).toMatch(/10\.0\.0\.1\s+answered icmp/);
    expect(out).toMatch(/10\.0\.0\.2\s+answered arp/);
    expect(out).not.toContain('10.0.0.3');
  });

  it('surfaces the reason an errored probe was treated as in use', async () => {
    const res = await probeAddresses(runner(
      () => { throw new Error('ping: permission denied'); }, () => false,
    ), ['10.0.0.1']);
    expect(describeProbe(res)).toMatch(/permission denied/);
    expect(describeProbe(res)).toMatch(/treating as IN USE/);
  });
});

describe('describeProbe ordering', () => {
  it('lists occupied addresses in ADDRESS order, not probe-completion order', async () => {
    // Probes run concurrently, so completion order is arbitrary. Measured on
    // a real network the report came out .100, .114, .111, .119, .130 --
    // hard to scan for a specific address.
    const taken = ['172.16.0.143', '172.16.0.100', '172.16.0.114', '172.16.0.111'];
    const res = await probeAddresses(
      { ping: async ip => taken.includes(ip), arping: async () => false },
      ['172.16.0.143', '172.16.0.100', '172.16.0.114', '172.16.0.111', '172.16.0.150'],
    );
    const lines = describeProbe(res).split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]);
    expect(lines).toEqual(['172.16.0.100', '172.16.0.111', '172.16.0.114', '172.16.0.143']);
  });

  it('orders numerically, so .9 comes before .10', async () => {
    const res = await probeAddresses(
      { ping: async () => true, arping: async () => false },
      ['10.0.0.10', '10.0.0.9', '10.0.0.100', '10.0.0.2'],
    );
    const lines = describeProbe(res).split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]);
    expect(lines).toEqual(['10.0.0.2', '10.0.0.9', '10.0.0.10', '10.0.0.100']);
  });
});
