import { planUeNatRules, ueNatRuleArgs } from '../host-tuning';
import { parseLiveRoutingProcess, ueNetworkStatementCommands } from '../frr/ue-subnet-mode';

// ── UE pool reachability has exactly two valid shapes ───────────────────────
//
// Either the pool is advertised into the live routing process, or it is
// MASQUERADEd on this host. Both of these halves had a real defect that
// presented as "UE attached, no internet" rather than as an error:
//
//  * the NAT planner's call site picked families BY ARRAY INDEX, so a second
//    IPv4 pool was handed to ip6tables and silently got no rule, and
//  * the FRR rollback could only restore MASQUERADE rules it had previously
//    removed, so on a never-NATed deployment it withdrew the routes and added
//    nothing.
//
// The live config this deployment actually runs is used as the fixture, because
// the stored migration state says "eigrp" while the host runs OSPF — the exact
// staleness that makes parsing the live config necessary.

// Trimmed from `vtysh -c "show running-config"` on the real host.
const LIVE_OSPF = `frr version 10.6.1-open5gsnms1
frr defaults traditional
hostname open5gs-core
!
ip prefix-list NMS_PL_MSC5W6D9 seq 10 permit 10.0.2.0/24
!
route-map NMS_IN permit 20
 match ip address prefix-list NMS_PL_MSC5W6D9
exit
!
interface ogstun
 ip ospf passive
exit
!
router ospf
 ospf router-id 192.168.253.2
 network 10.0.1.155/32 area 0
 network 192.168.253.0/24 area 0
exit
!
ip protocol ospf route-map NMS_IN
!
end`;

describe('planUeNatRules — family and device come from the pool, not its index', () => {
  const POOLS = [
    { subnet: '10.45.0.0/24', dev: 'ogstun' },
    { subnet: '10.46.0.0/24', dev: 'ogstun2' },
  ];

  test('two IPv4 pools both get an iptables rule on their own device', () => {
    // The original bug: pool[1] was assumed IPv6, so this pool went to
    // ip6tables, which rejects an IPv4 CIDR. The executor returns a non-zero
    // exit code instead of throwing, so the IMS pool silently had no NAT.
    const rules = planUeNatRules(POOLS);
    expect(rules).toEqual([
      { bin: 'iptables', family: 4, subnet: '10.45.0.0/24', dev: 'ogstun' },
      { bin: 'iptables', family: 4, subnet: '10.46.0.0/24', dev: 'ogstun2' },
    ]);
  });

  test('an IPv6 pool is routed to ip6tables wherever it sits in the list', () => {
    const rules = planUeNatRules([
      { subnet: '2001:db8:cafe::/48', dev: 'ogstun' },
      { subnet: '10.45.0.0/24', dev: 'ogstun' },
    ]);
    expect(rules.map(r => [r.bin, r.family])).toEqual([['ip6tables', 6], ['iptables', 4]]);
  });

  test('a pool with no dev falls back, and duplicates collapse', () => {
    const rules = planUeNatRules(
      [{ subnet: '10.45.0.0/24' }, { subnet: '10.45.0.0/24', dev: 'ogstun' }],
      'ogstun',
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].dev).toBe('ogstun');
  });

  test('a blank subnet is dropped, never widened into a match-all rule', () => {
    expect(planUeNatRules([{ subnet: '' }, { subnet: '   ' }])).toEqual([]);
    expect(planUeNatRules(undefined as any)).toEqual([]);
  });

  test('the emitted rule is byte-identical to what the host runs', () => {
    // This exact argument vector is what was applied and persisted live; it is
    // also the shape gsm-controller.ts and ims-controller.ts already use, so a
    // -C check from any of them matches the others instead of duplicating.
    const [v4] = planUeNatRules([POOLS[0]]);
    expect(ueNatRuleArgs('-A', v4)).toEqual([
      '-t', 'nat', '-A', 'POSTROUTING',
      '-s', '10.45.0.0/24', '!', '-o', 'ogstun', '-j', 'MASQUERADE',
    ]);
    // -C and -D must differ from -A in the operation alone, or idempotency
    // checks and teardown silently address a different rule.
    expect(ueNatRuleArgs('-C', v4)[2]).toBe('-C');
    expect(ueNatRuleArgs('-D', v4)[2]).toBe('-D');
    expect(ueNatRuleArgs('-C', v4).filter((_, i) => i !== 2))
      .toEqual(ueNatRuleArgs('-A', v4).filter((_, i) => i !== 2));
  });
});

describe('parseLiveRoutingProcess — trust FRR, not the stored state', () => {
  test('reads the protocol and area off the live OSPF config', () => {
    expect(parseLiveRoutingProcess(LIVE_OSPF)).toEqual({
      protocol: 'ospf', routerLine: 'router ospf', area: '0',
    });
  });

  test('a non-backbone area is read, not assumed to be 0', () => {
    // `no network X area 0` is rejected when the statement was added with a
    // different area, so guessing makes every withdrawal a silent no-op.
    const conf = 'router ospf\n network 10.45.0.0/24 area 7\nexit\nend';
    expect(parseLiveRoutingProcess(conf)?.area).toBe('7');
  });

  test('the AS number is carried verbatim for EIGRP and BGP', () => {
    // Re-entering `router bgp 1` when the live process is `router bgp 65001`
    // would create a second, broken instance rather than editing this one.
    expect(parseLiveRoutingProcess('router eigrp 1\n network 10.45.0.0/24\nexit')?.routerLine)
      .toBe('router eigrp 1');
    expect(parseLiveRoutingProcess('router bgp 65001\n!\nexit')?.routerLine)
      .toBe('router bgp 65001');
  });

  test('no routing process means none is invented', () => {
    expect(parseLiveRoutingProcess('hostname open5gs-core\nend')).toBeNull();
    expect(parseLiveRoutingProcess('')).toBeNull();
  });

  test('a line merely mentioning a protocol is not the stanza header', () => {
    // `ip protocol ospf route-map NMS_IN` is a real line in the live config
    // and sits outside any router stanza.
    expect(parseLiveRoutingProcess('ip protocol ospf route-map NMS_IN\nend')).toBeNull();
  });

  test('free text elsewhere in the config cannot be mistaken for the header', () => {
    // The match must be anchored to the start of the line. The live config
    // carries a route-map `description`, which is free text an operator can
    // put anything in — an unanchored search finds it before the real stanza
    // and would then edit a BGP process that does not exist.
    const conf = [
      'route-map NMS_OUT permit 10',
      ' description uplink to router bgp 65001 — must not match',
      'exit',
      '!',
      'router ospf',
      ' network 10.45.0.0/24 area 0',
      'exit',
    ].join('\n');
    expect(parseLiveRoutingProcess(conf)).toEqual({
      protocol: 'ospf', routerLine: 'router ospf', area: '0',
    });
  });
});

describe('ueNetworkStatementCommands', () => {
  const ospf = parseLiveRoutingProcess(LIVE_OSPF)!;

  test('withdrawal re-enters the real stanza and negates each statement', () => {
    expect(ueNetworkStatementCommands(ospf, ['10.45.0.0/24', '10.46.0.0/24'], 'remove')).toEqual([
      'configure terminal',
      'router ospf',
      'no network 10.45.0.0/24 area 0',
      'no network 10.46.0.0/24 area 0',
      'end',
    ]);
  });

  test('add is the exact inverse of remove', () => {
    const add = ueNetworkStatementCommands(ospf, ['10.45.0.0/24'], 'add');
    const rm  = ueNetworkStatementCommands(ospf, ['10.45.0.0/24'], 'remove');
    expect(add).toEqual(['configure terminal', 'router ospf', 'network 10.45.0.0/24 area 0', 'end']);
    expect(rm.map(c => c.replace(/^no /, ''))).toEqual(add);
  });

  test('EIGRP takes no area', () => {
    const eigrp = parseLiveRoutingProcess('router eigrp 1\nexit')!;
    expect(ueNetworkStatementCommands(eigrp, ['10.45.0.0/24'], 'remove'))
      .toEqual(['configure terminal', 'router eigrp 1', 'no network 10.45.0.0/24', 'end']);
  });

  test('BGP puts each pool in its own address family', () => {
    const bgp = parseLiveRoutingProcess('router bgp 65001\nexit')!;
    expect(ueNetworkStatementCommands(bgp, ['10.45.0.0/24', '2001:db8:cafe::/48'], 'add')).toEqual([
      'configure terminal',
      'router bgp 65001',
      'address-family ipv4 unicast', 'network 10.45.0.0/24', 'exit-address-family',
      'address-family ipv6 unicast', 'network 2001:db8:cafe::/48', 'exit-address-family',
      'end',
    ]);
  });

  test('no subnets emits nothing — never a bare "configure terminal"', () => {
    // An empty command list is what tells the caller to skip vtysh entirely;
    // emitting a config-mode entry with no statements would still rewrite
    // frr.conf on the following `write memory`.
    expect(ueNetworkStatementCommands(ospf, [], 'remove')).toEqual([]);
    expect(ueNetworkStatementCommands(ospf, ['', '  '], 'add')).toEqual([]);
  });
});
