import {
  parseEigrpTopology,
  parseEigrpNeighbors,
  parseKernelNexthops,
  parseKernelRoutes,
  diagnoseEigrpHealth,
} from '../eigrp-health';

// Every fixture here is real output captured from this deployment's own
// router, in both the healthy and the reproduced-fault states — not invented.
// The fault states came from forcing the bug with `clear ip eigrp neighbors`
// and with an `ens20` link flap on 2026-11-03.

const HEALTHY_TOPOLOGY = `
EIGRP Topology Table for AS(1)/ID(192.168.253.2)

Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply
       r - reply Status, s - sia Status

P  10.0.1.155/32, 1 successors, FD is 28160, serno: 0
       via Connected, dummy-amf
P  10.45.0.0/24, 1 successors, FD is 28160, serno: 0
       via Connected, ogstun
P  10.0.2.0/24, 1 successors, FD is 5376, serno: 0
       via 192.168.253.1 (5376/2816), ens20
P  172.16.1.0/24, 1 successors, FD is 5376, serno: 0
       via 192.168.253.1 (5376/2816), ens20
`;

// The 4-successor state observed in production at 07:37 on 2026-11-03: two
// junk next hops from freed memory, and the real neighbour listed twice.
const CORRUPT_TOPOLOGY_4 = `
P  10.0.2.0/24, 4 successors, FD is 5376, serno: 0
       via 81.0.0.0 (5376/2816), ens20
       via 192.168.253.1 (5376/2816), ens20
       via 0.10.0.0 (5376/2816), ens20
       via 192.168.253.1 (5376/2816), ens20
P  172.16.1.0/24, 1 successors, FD is 5376, serno: 0
       via 192.168.253.1 (5376/2816), ens20
`;

// The 2-successor state reproduced on demand. One junk entry beside one real
// one — no duplicate, which is why "not a current neighbour" is the rule.
const CORRUPT_TOPOLOGY_2 = `
P  10.0.2.0/24, 2 successors, FD is 5376, serno: 0
       via 32.75.32.23 (5376/2816), ens20
       via 192.168.253.1 (5376/2816), ens20
`;

const NEIGHBORS = `
EIGRP neighbors for AS(1)

H   Address           Interface            Hold   Uptime   SRTT   RTO   Q     Seq
                                           (sec)           (ms)        Cnt    Num
0   192.168.253.1     ens20                12     0        0      2    0      2533
`;

const HEALTHY_ROUTES = `
default via 172.16.0.1 dev ens18 proto static
10.0.2.0/24 nhid 184 via 192.168.253.1 dev ens20 proto eigrp metric 20
10.45.0.0/24 dev ogstun proto kernel scope link src 10.45.0.1
172.16.0.0/24 dev ens18 proto kernel scope link src 172.16.0.168
172.16.1.0/24 nhid 184 via 192.168.253.1 dev ens20 proto eigrp metric 20
192.168.253.0/30 dev ens20 proto kernel scope link src 192.168.253.2
`;

// id 180 is the orphaned gateway-less row a flap leaves behind; nothing
// references it, so it must NOT be reported.
const HEALTHY_NEXTHOPS = `
id 180 dev ens20 scope host proto zebra
id 184 via 192.168.253.1 dev ens20 scope link proto zebra
`;

describe('parsing real router output', () => {
  test('topology prefixes and their next hops', () => {
    const t = parseEigrpTopology(HEALTHY_TOPOLOGY);
    expect(t).toHaveLength(4);
    expect(t[0]).toEqual({
      prefix: '10.0.1.155/32',
      successors: 1,
      entries: [{ via: 'Connected', connected: true }],
    });
    expect(t[2].entries).toEqual([{ via: '192.168.253.1', connected: false }]);
  });

  test('a 4-successor prefix keeps every entry, including the repeated one', () => {
    const t = parseEigrpTopology(CORRUPT_TOPOLOGY_4);
    expect(t[0].successors).toBe(4);
    expect(t[0].entries.map(e => e.via)).toEqual([
      '81.0.0.0', '192.168.253.1', '0.10.0.0', '192.168.253.1',
    ]);
  });

  test('neighbours, skipping the two header lines', () => {
    expect([...parseEigrpNeighbors(NEIGHBORS)]).toEqual(['192.168.253.1']);
  });

  test('nexthops, distinguishing a gateway-less row from a real one', () => {
    const nh = parseKernelNexthops(HEALTHY_NEXTHOPS);
    expect(nh).toEqual([
      { id: 180, via: null, group: [] },
      { id: 184, via: '192.168.253.1', group: [] },
    ]);
  });

  test('a group row carries members and no gateway of its own', () => {
    const nh = parseKernelNexthops('id 518 group 85/90 proto zebra\nid 85 via 10.0.0.1 dev eth0\n');
    expect(nh[0]).toEqual({ id: 518, via: null, group: [85, 90] });
  });

  test('weighted group members parse', () => {
    expect(parseKernelNexthops('id 7 group 85,1/90,1 proto zebra')[0].group).toEqual([85, 90]);
  });

  test('routes, ignoring continuation lines', () => {
    const r = parseKernelRoutes(HEALTHY_ROUTES);
    expect(r.map(x => x.prefix)).toContain('10.0.2.0/24');
    expect(r.find(x => x.prefix === '10.0.2.0/24')).toMatchObject({ nhid: 184, proto: 'eigrp' });
    expect(parseKernelRoutes('10.1.0.0/24 nhid 9\n\tnexthop dev eth0 weight 1\n')).toHaveLength(1);
  });
});

describe('a healthy router is reported healthy', () => {
  const health = diagnoseEigrpHealth({
    topology: HEALTHY_TOPOLOGY,
    routes: HEALTHY_ROUTES,
    nexthops: HEALTHY_NEXTHOPS,
    neighbors: NEIGHBORS,
    requiredPrefixes: ['10.0.2.0/24', '172.16.1.0/24'],
  });

  test('no findings at all', () => {
    expect(health.findings).toEqual([]);
    expect(health.degraded).toBe(false);
  });

  // The whole point of resolving a route's nhid to its leaves: an unreferenced
  // gateway-less nexthop is a zebra leftover, not a forwarding fault. Reporting
  // it would make the guard restart FRR after every link flap forever.
  test('an ORPHANED gateway-less nexthop is not a finding', () => {
    expect(health.findings.find(f => f.kind === 'vialess-nexthop-in-use')).toBeUndefined();
  });
});

describe('topology corruption is reported but never called traffic-affecting', () => {
  // This is the 6th-occurrence lesson encoded: corrupt topology, clean kernel,
  // no outage. If this test ever flips to degraded:true, the guard will start
  // restarting FRR on a working network.
  test('4-successor state with a clean kernel table is NOT degraded', () => {
    const health = diagnoseEigrpHealth({
      topology: CORRUPT_TOPOLOGY_4,
      routes: HEALTHY_ROUTES,
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: NEIGHBORS,
      requiredPrefixes: ['10.0.2.0/24', '172.16.1.0/24'],
    });
    expect(health.findings.map(f => f.kind)).toEqual(['topology-corruption']);
    expect(health.corruptPrefixes).toBe(1);
    expect(health.degraded).toBe(false);
  });

  test('the 2-successor junk-beside-real state is caught, which a duplicate rule misses', () => {
    const health = diagnoseEigrpHealth({
      topology: CORRUPT_TOPOLOGY_2,
      routes: HEALTHY_ROUTES,
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: NEIGHBORS,
    });
    expect(health.findings.map(f => f.kind)).toEqual(['topology-corruption']);
    expect(health.findings[0].prefixes).toEqual(['10.0.2.0/24']);
  });

  test('without a neighbour table the duplicate fallback still catches the 4-successor state', () => {
    const health = diagnoseEigrpHealth({
      topology: CORRUPT_TOPOLOGY_4, routes: HEALTHY_ROUTES, nexthops: HEALTHY_NEXTHOPS,
    });
    expect(health.corruptPrefixes).toBe(1);
  });

  test('an empty neighbour table is not treated as "everything is corrupt"', () => {
    // Every adjacency down means every learned entry is legitimately pending
    // removal. Flagging all of them would turn a normal outage into a restart
    // loop on top of it.
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: HEALTHY_ROUTES,
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: 'EIGRP neighbors for AS(1)\n\nH   Address\n',
    });
    expect(health.findings).toEqual([]);
  });

  test('genuine multipath through two different real neighbours is not corruption', () => {
    const health = diagnoseEigrpHealth({
      topology: `
P  10.9.0.0/24, 2 successors, FD is 5376, serno: 0
       via 192.168.253.1 (5376/2816), ens20
       via 192.168.254.1 (5376/2816), ens21
`,
      routes: HEALTHY_ROUTES,
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: `
H   Address           Interface
0   192.168.253.1     ens20                12     0        0      2    0      1
1   192.168.254.1     ens21                12     0        0      2    0      1
`,
    });
    expect(health.findings).toEqual([]);
  });
});

describe('kernel faults are the ones that justify a restart', () => {
  test('a gateway-less nexthop IN USE by a route is traffic-affecting', () => {
    // Exactly the state measured mid-fault: the route still points at nexthop
    // 180, which lost its gateway, so the kernel treats the destination as
    // on-link and ARPs for it on a segment it is not on.
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: '10.0.2.0/24 nhid 180 dev ens20 proto eigrp metric 20\n',
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: NEIGHBORS,
    });
    const f = health.findings.find(x => x.kind === 'vialess-nexthop-in-use');
    expect(f).toBeDefined();
    expect(f!.trafficAffecting).toBe(true);
    expect(f!.prefixes).toEqual(['10.0.2.0/24']);
    expect(health.degraded).toBe(true);
  });

  // Added after a mutation test: breaking leafNexthops() so it judged the
  // GROUP row instead of resolving to members left all other tests green,
  // because a group row legitimately carries no gateway of its own. Without
  // this case, that bug would report every multipath route as faulty and the
  // guard would restart FRR on a perfectly healthy ECMP table.
  test('a healthy multipath group, every member with a gateway, is not a finding', () => {
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: '10.0.2.0/24 nhid 518 proto eigrp metric 20\n',
      nexthops: 'id 518 group 184/185 proto zebra\nid 184 via 192.168.253.1 dev ens20\nid 185 via 192.168.253.5 dev ens21\n',
      neighbors: NEIGHBORS,
    });
    expect(health.findings).toEqual([]);
    expect(health.degraded).toBe(false);
  });

  test('a gateway-less MEMBER of a multipath group is traffic-affecting', () => {
    // The 2026-09-24 production shape: a group with one real member and one
    // via-less member, so ECMP hashing blackholes a fraction of flows.
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: '10.0.2.0/24 nhid 518 proto eigrp metric 20\n',
      nexthops: 'id 518 group 184/180 proto zebra\nid 184 via 192.168.253.1 dev ens20\nid 180 dev ens20 scope host\n',
      neighbors: NEIGHBORS,
    });
    expect(health.degraded).toBe(true);
    expect(health.findings[0].kind).toBe('vialess-nexthop-in-use');
  });

  test('a required prefix known to EIGRP but absent from the kernel is traffic-affecting', () => {
    // The post-flap state: zebra holds the route without installing it.
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: '172.16.1.0/24 nhid 184 via 192.168.253.1 dev ens20 proto eigrp\n',
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: NEIGHBORS,
      requiredPrefixes: ['10.0.2.0/24', '172.16.1.0/24'],
    });
    const f = health.findings.find(x => x.kind === 'missing-kernel-route');
    expect(f!.prefixes).toEqual(['10.0.2.0/24']);
    expect(health.degraded).toBe(true);
  });

  test('a prefix EIGRP never learned is not reported as missing', () => {
    // EIGRP legitimately does not install everything. Only a prefix that is
    // both required and present in the topology counts.
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: HEALTHY_ROUTES,
      nexthops: HEALTHY_NEXTHOPS,
      neighbors: NEIGHBORS,
      requiredPrefixes: ['10.99.0.0/24'],
    });
    expect(health.findings).toEqual([]);
  });

  test('no requiredPrefixes means the missing-route check stays silent', () => {
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY, routes: '', nexthops: HEALTHY_NEXTHOPS, neighbors: NEIGHBORS,
    });
    expect(health.findings.find(f => f.kind === 'missing-kernel-route')).toBeUndefined();
  });

  test('a self-referential nexthop group terminates instead of spinning', () => {
    const health = diagnoseEigrpHealth({
      topology: HEALTHY_TOPOLOGY,
      routes: '10.0.2.0/24 nhid 1 proto eigrp\n',
      nexthops: 'id 1 group 2 proto zebra\nid 2 group 1 proto zebra\n',
      neighbors: NEIGHBORS,
    });
    expect(health).toBeDefined();
  });
});
