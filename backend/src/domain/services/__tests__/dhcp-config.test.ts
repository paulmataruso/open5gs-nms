import {
  parseDhcpInterfaces, validateDhcpConfig, buildKeaConfig, parseKeaConfig,
  parseKeaLeases, normalizeMac, reservedIpsOf, splitLeaseRow, decodeClientId,
  EMPTY_DHCP_CONFIG, DEFAULT_LEASE_LIFETIME,
  type DhcpConfig, type DhcpInterface,
} from '../dhcp-config';

// Real `ip -o -4 addr show` output from this deployment, trimmed.
const ADDR = `1: lo    inet 127.0.0.1/8 scope host lo
2: ens18    inet 172.16.0.168/24 brd 172.16.0.255 scope global ens18
3: ens20    inet 192.168.253.2/30 brd 192.168.253.3 scope global ens20
5: dummy-amf    inet 10.0.1.155/32 scope global dummy-amf
9: ogstun2    inet 10.46.0.1/24 brd 10.46.0.255 scope global ogstun2
514: ogstun    inet 10.45.0.1/24 brd 10.45.0.255 scope global ogstun
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
7: br-1a2b3c4d5e    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-1a2b3c4d5e`;

const DUMMY = `5: dummy-amf: <BROADCAST,NOARP,UP,LOWER_UP> mtu 1500
10: dummy-dns: <BROADCAST,NOARP,UP,LOWER_UP> mtu 1500`;

const ifaces = () => parseDhcpInterfaces(ADDR, DUMMY);
const find = (name: string) => ifaces().find(i => i.name === name)!;

describe('parseDhcpInterfaces', () => {
  test('offers real interfaces with their CIDR', () => {
    expect(find('ens18')).toMatchObject({ cidr: '172.16.0.168/24', blocked: false, isDummy: false });
  });

  test('BLOCKS the Open5GS UE tunnels — the UPF owns those addresses', () => {
    for (const n of ['ogstun', 'ogstun2']) {
      expect(find(n).blocked).toBe(true);
      expect(find(n).warnings[0]).toMatch(/UPF allocates addresses here itself/);
    }
  });

  test('blocks loopback', () => {
    expect(find('lo').blocked).toBe(true);
  });

  test('BLOCKS Docker bridges — Docker\'s IPAM already assigns there', () => {
    // Found by running the real interface list on a live host: docker0 came
    // back selectable, which would put a DHCP server in competition with
    // Docker's own allocator.
    for (const n of ['docker0', 'br-1a2b3c4d5e']) {
      expect(find(n).blocked).toBe(true);
      expect(find(n).warnings[0]).toMatch(/Docker's own IPAM/);
    }
  });

  test('includes dummy interfaces but flags them', () => {
    // Explicitly requested: dummies must be selectable, not hidden.
    const d = find('dummy-amf');
    expect(d.isDummy).toBe(true);
    expect(d.warnings.join(' ')).toMatch(/no physical segment/);
  });

  test('warns that a /32 or /31 has nothing to lease', () => {
    expect(find('dummy-amf').localPoolWarnings.join(' ')).toMatch(/no assignable host range/);
  });

  test('warns that a /30 leaves exactly one leasable address', () => {
    // ens20 is 192.168.253.2/30 — two host addresses, one of them the server's.
    // Legal, and almost certainly not what was intended.
    expect(find('ens20').localPoolWarnings.join(' ')).toMatch(/only one address to lease/);
    expect(find('ens20').localPoolWarnings.join(' ')).not.toMatch(/no assignable host range/);
  });

  test('a prefix-size note is a local-pool note, never a plain warning', () => {
    // Binding a narrow transit interface purely to RECEIVE relayed requests for
    // remote subnets is normal, so these must not read as "wrong interface".
    expect(find('ens20').warnings.join(' ')).not.toMatch(/address to lease|assignable host range/);
    expect(find('dummy-amf').warnings.join(' ')).not.toMatch(/assignable host range/);
  });

  test('a normal /24 draws no range warning at all', () => {
    expect(find('ens18').warnings).toEqual([]);
    expect(find('ens18').localPoolWarnings).toEqual([]);
  });

  test('a dummy with no IPv4 at all still appears, explaining why it is unusable', () => {
    const d = find('dummy-dns');
    expect(d).toMatchObject({ cidr: null, blocked: true });
    expect(d.warnings[0]).toMatch(/No IPv4 address/);
  });

  test('tolerates empty input', () => {
    expect(parseDhcpInterfaces('', '')).toEqual([]);
  });
});

const baseCfg = (over: Partial<DhcpConfig> = {}): DhcpConfig => ({
  ...EMPTY_DHCP_CONFIG,
  interfaces: ['ens18'],
  subnets: [{
    id: 1, subnet: '172.16.0.0/24',
    pools: [{ start: '172.16.0.50', end: '172.16.0.100' }],
    routers: ['172.16.0.1'], dnsServers: ['10.0.1.180'],
    leaseLifetime: 3600, reservations: [],
  }],
  ...over,
});

describe('validateDhcpConfig', () => {
  const all = ifaces();

  test('a sane config is clean', () => {
    const v = validateDhcpConfig(baseCfg(), all);
    expect(v.errors).toEqual([]);
  });

  test('refuses binding to a UE tunnel', () => {
    const v = validateDhcpConfig(baseCfg({ interfaces: ['ogstun'] }), all);
    expect(v.errors.join(' ')).toMatch(/Cannot serve DHCP on ogstun/);
  });

  test('allows a dummy interface but surfaces its warnings', () => {
    const v = validateDhcpConfig(baseCfg({ interfaces: ['dummy-amf'] }), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/dummy-amf/);
  });

  test('rejects a pool outside its subnet', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], pools: [{ start: '10.9.9.1', end: '10.9.9.9' }] }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/falls outside the subnet/);
  });

  test('rejects a reversed pool range', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], pools: [{ start: '172.16.0.100', end: '172.16.0.50' }] }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/is above its end/);
  });

  test('rejects overlapping pools in one subnet', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], pools: [
        { start: '172.16.0.50', end: '172.16.0.100' },
        { start: '172.16.0.90', end: '172.16.0.120' },
      ] }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/overlap/);
  });

  test('rejects overlapping subnets', () => {
    const s = baseCfg().subnets[0];
    const v = validateDhcpConfig(baseCfg({
      subnets: [s, { ...s, id: 2, subnet: '172.16.0.128/25' }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/172\.16\.0\.0\/24 and 172\.16\.0\.128\/25 overlap/);
  });

  test('rejects an out-of-subnet reservation — Kea refuses to START on one', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.1.1.1' }] }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/is outside the subnet/);
  });

  test('rejects a malformed MAC', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [{ mac: 'nope', ip: '172.16.0.10' }] }],
    }), all);
    expect(v.errors.join(' ')).toMatch(/not a valid MAC/);
  });

  test('accepts dash- and dot-separated MACs by normalising them', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [{ mac: 'AA-BB-CC-DD-EE-FF', ip: '172.16.0.10' }] }],
    }), all);
    expect(v.errors).toEqual([]);
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
  });

  test('rejects the same IP reserved for two MACs, and the same MAC reserved twice', () => {
    const dupIp = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '172.16.0.10' },
        { mac: 'aa:bb:cc:dd:ee:02', ip: '172.16.0.10' },
      ] }],
    }), all);
    expect(dupIp.errors.join(' ')).toMatch(/reserved for two different MACs/);

    const dupMac = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '172.16.0.10' },
        { mac: 'aa:bb:cc:dd:ee:01', ip: '172.16.0.11' },
      ] }],
    }), all);
    expect(dupMac.errors.join(' ')).toMatch(/reserved twice/);
  });

  test('warns when a reservation sits inside a dynamic pool', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '172.16.0.60' }] }],
    }), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/sits inside a dynamic pool/);
  });

  test('warns, not errors, when a gateway is outside the subnet', () => {
    const v = validateDhcpConfig(baseCfg({
      subnets: [{ ...baseCfg().subnets[0], routers: ['192.0.2.1'] }],
    }), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/gateway they cannot ARP for/);
  });

  test('warns when subnets exist but no interface is selected', () => {
    expect(validateDhcpConfig(baseCfg({ interfaces: [] }), all).warnings.join(' '))
      .toMatch(/no interface is selected/);
  });
});

// ── Remote subnets behind a DHCP relay ──────────────────────────────────────
//
// The point of these: a subnet is NOT derived from, and need not match, any
// bound interface. Kea's documented rule is that a relayed message "is accepted
// through any interface" and "the giaddr set by the relay agent is used to
// select the subnet for the client" — so a remote segment is an ordinary
// subnet, not a special case, and must never be refused for being remote.

describe('relayed (remote) subnets', () => {
  const all = ifaces();

  // 203.0.113.0/24 is deliberately nowhere near any interface on this host.
  const remote = (over: Partial<DhcpConfig['subnets'][number]> = {}) => baseCfg({
    interfaces: ['ens18'],
    subnets: [{
      id: 7, subnet: '203.0.113.0/24',
      pools: [{ start: '203.0.113.50', end: '203.0.113.200' }],
      routers: ['203.0.113.1'], dnsServers: ['10.0.1.180'],
      leaseLifetime: 3600, reservations: [],
      ...over,
    }],
  });

  test('a subnet matching NO local interface is accepted without complaint', () => {
    const v = validateDhcpConfig(remote(), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).not.toMatch(/203\.0\.113/);
  });

  test('binding a /30 transit interface draws no leasable-address warning when no subnet covers it', () => {
    // ens20 is 192.168.253.2/30. Receiving RELAYED requests there is normal, so
    // "only one address to lease" — which is about leasing out of the
    // interface's own range — must stay silent.
    const v = validateDhcpConfig(remote({ }), all);
    const withTransit = validateDhcpConfig(
      { ...remote(), interfaces: ['ens18', 'ens20'] }, all,
    );
    expect(v.warnings.join(' ')).not.toMatch(/address to lease/);
    expect(withTransit.errors).toEqual([]);
    expect(withTransit.warnings.join(' ')).not.toMatch(/address to lease/);
  });

  test('...but still warns once a subnet DOES lease out of that interface’s range', () => {
    const v = validateDhcpConfig(baseCfg({
      interfaces: ['ens20'],
      subnets: [{
        id: 1, subnet: '192.168.253.0/30', pools: [{ start: '192.168.253.1', end: '192.168.253.1' }],
        routers: [], dnsServers: [], leaseLifetime: 3600, reservations: [],
      }],
    }), all);
    expect(v.warnings.join(' ')).toMatch(/only one address to lease/);
  });

  test('relay addresses round-trip through Kea’s own relay block', () => {
    const cfg = remote({ relayIps: ['198.51.100.9'] });
    const doc: any = buildKeaConfig(cfg);
    expect(doc.Dhcp4.subnet4[0].relay).toEqual({ 'ip-addresses': ['198.51.100.9'] });
    expect(parseKeaConfig(JSON.stringify(doc))).toEqual(cfg);
  });

  test('a subnet with no relay addresses emits no relay block at all', () => {
    const doc: any = buildKeaConfig(remote());
    expect(doc.Dhcp4.subnet4[0].relay).toBeUndefined();
    // Absent, not empty — otherwise a plain config stops round-tripping.
    expect(parseKeaConfig(JSON.stringify(doc)).subnets[0].relayIps).toBeUndefined();
  });

  test('rejects a malformed relay address', () => {
    const v = validateDhcpConfig(remote({ relayIps: ['not-an-ip'] }), all);
    expect(v.errors.join(' ')).toMatch(/relay address not-an-ip is not a valid IPv4 address/);
  });

  test('warns when a subnet is pinned to an interface that holds no address in it', () => {
    // A pin names the interface a DIRECTLY CONNECTED client arrives on, so this
    // describes a path that cannot exist.
    const v = validateDhcpConfig(remote({ iface: 'ens18' }), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/pinned to ens18, which has no address in this subnet/);
  });

  test('warns when a subnet is both pinned and given relay addresses', () => {
    const v = validateDhcpConfig(remote({ iface: 'ens18', relayIps: ['198.51.100.9'] }), all);
    expect(v.warnings.join(' ')).toMatch(/reached one way or the other/);
  });

  test('a pin that matches a local interface is silent', () => {
    const v = validateDhcpConfig(baseCfg({ subnets: [{ ...baseCfg().subnets[0], iface: 'ens18' }] }), all);
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(' ')).not.toMatch(/pinned to/);
  });
});

describe('buildKeaConfig / parseKeaConfig', () => {
  test('round-trips a config without losing anything', () => {
    const cfg = baseCfg({
      subnets: [{
        id: 7, subnet: '192.168.50.0/24',
        pools: [{ start: '192.168.50.100', end: '192.168.50.200' }],
        routers: ['192.168.50.1'], dnsServers: ['192.168.50.1', '1.1.1.1'],
        domainName: 'lab.local', leaseLifetime: 7200, iface: 'ens18',
        reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '192.168.50.10', hostname: 'printer' }],
      }],
    });
    expect(parseKeaConfig(JSON.stringify(buildKeaConfig(cfg)))).toEqual(cfg);
  });

  test('always emits a control socket, so leases need no restart to read', () => {
    const d = buildKeaConfig(baseCfg()).Dhcp4 as any;
    expect(d['control-socket']['socket-type']).toBe('unix');
  });

  test('pools are emitted in Kea\'s "start - end" form', () => {
    const d = buildKeaConfig(baseCfg()).Dhcp4 as any;
    expect(d.subnet4[0].pools).toEqual([{ pool: '172.16.0.50 - 172.16.0.100' }]);
  });

  test('tolerates the // comments Kea ships in its own stock config', () => {
    const raw = `{
      // Kea's packaged config is commented like this, which JSON.parse rejects.
      "Dhcp4": {
        "interfaces-config": { "interfaces": [ "ens18" ] },
        "subnet4": []
      }
    }`;
    expect(parseKeaConfig(raw).interfaces).toEqual(['ens18']);
  });

  test('garbage or missing config reads as empty rather than throwing', () => {
    expect(parseKeaConfig('not json')).toEqual(EMPTY_DHCP_CONFIG);
    expect(parseKeaConfig('{}')).toEqual(EMPTY_DHCP_CONFIG);
    expect(parseKeaConfig('')).toEqual(EMPTY_DHCP_CONFIG);
  });

  test('a subnet with no valid-lifetime inherits the global one', () => {
    const raw = JSON.stringify({ Dhcp4: { 'valid-lifetime': 1234, subnet4: [{ id: 1, subnet: '10.0.0.0/24' }] } });
    expect(parseKeaConfig(raw).subnets[0].leaseLifetime).toBe(1234);
  });

  test('a config with neither inherits the documented default', () => {
    const raw = JSON.stringify({ Dhcp4: { subnet4: [{ id: 1, subnet: '10.0.0.0/24' }] } });
    expect(parseKeaConfig(raw).subnets[0].leaseLifetime).toBe(DEFAULT_LEASE_LIFETIME);
  });
});

describe('parseKeaLeases', () => {
  const NOW = 1_800_000_000;
  const HDR = 'address,hwaddr,client_id,valid_lifetime,expire,subnet_id,fqdn_fwd,fqdn_rev,hostname,state,user_context,pool_id';

  test('takes the LAST row for an address — the file is append-only', () => {
    // Same IP renewed onto a different MAC. Taking the first row reports the
    // stale client; counting rows reports two leases where there is one.
    const csv = [HDR,
      `10.0.0.5,aa:bb:cc:dd:ee:01,,3600,${NOW + 100},1,0,0,old,0,,0`,
      `10.0.0.5,aa:bb:cc:dd:ee:02,,3600,${NOW + 3600},1,0,0,new,0,,0`,
    ].join('\n');
    const leases = parseKeaLeases(csv, NOW);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ mac: 'aa:bb:cc:dd:ee:02', hostname: 'new', state: 'active' });
  });

  test('valid_lifetime 0 is a RELEASED lease, not an active one', () => {
    const csv = [HDR, `10.0.0.9,aa:bb:cc:dd:ee:03,,0,${NOW + 3600},1,0,0,,0,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0].state).toBe('released');
  });

  test('a past expiry reads as expired even with state 0', () => {
    const csv = [HDR, `10.0.0.8,aa:bb:cc:dd:ee:04,,3600,${NOW - 10},1,0,0,,0,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0].state).toBe('expired');
  });

  test('state 1 is a declined address', () => {
    const csv = [HDR, `10.0.0.7,aa:bb:cc:dd:ee:05,,3600,${NOW + 60},1,0,0,,1,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0].state).toBe('declined');
  });

  test('active leases sort first, then by address', () => {
    const csv = [HDR,
      `10.0.0.20,aa:bb:cc:dd:ee:06,,3600,${NOW - 1},1,0,0,,0,,0`,
      `10.0.0.3,aa:bb:cc:dd:ee:07,,3600,${NOW + 60},1,0,0,,0,,0`,
      `10.0.0.2,aa:bb:cc:dd:ee:08,,3600,${NOW + 60},1,0,0,,0,,0`,
    ].join('\n');
    expect(parseKeaLeases(csv, NOW).map(l => l.ip)).toEqual(['10.0.0.2', '10.0.0.3', '10.0.0.20']);
  });

  test('marks addresses a reservation pins', () => {
    const csv = [HDR, `10.0.0.5,aa:bb:cc:dd:ee:01,,3600,${NOW + 60},1,0,0,,0,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW, new Set(['10.0.0.5']))[0].reserved).toBe(true);
  });

  test('honours a header with extra/reordered columns rather than fixed offsets', () => {
    const csv = ['address,hwaddr,valid_lifetime,expire,subnet_id,hostname,state',
      `10.0.0.5,aa:bb:cc:dd:ee:01,3600,${NOW + 60},4,host-a,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0]).toMatchObject({ subnetId: 4, hostname: 'host-a', state: 'active' });
  });

  test('works with no header row at all', () => {
    const csv = `10.0.0.5,aa:bb:cc:dd:ee:01,,3600,${NOW + 60},1,0,0,h,0,,0`;
    expect(parseKeaLeases(csv, NOW)[0].ip).toBe('10.0.0.5');
  });

  test('empty, header-only and garbage input all give no leases', () => {
    expect(parseKeaLeases('', NOW)).toEqual([]);
    expect(parseKeaLeases(HDR, NOW)).toEqual([]);
    expect(parseKeaLeases('junk\nmore junk', NOW)).toEqual([]);
  });

  test('reservedIpsOf collects every pinned address across subnets', () => {
    const cfg = baseCfg({ subnets: [
      { ...baseCfg().subnets[0], reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '172.16.0.10' }] },
      { ...baseCfg().subnets[0], id: 2, subnet: '10.8.0.0/24', pools: [],
        reservations: [{ mac: 'aa:bb:cc:dd:ee:02', ip: '10.8.0.5' }] },
    ] });
    expect([...reservedIpsOf(cfg)].sort()).toEqual(['10.8.0.5', '172.16.0.10']);
  });

  // ── detail fields, for the lease detail view ───────────────────────────

  test('surfaces the detail fields Kea records, not just the summary ones', () => {
    const csv = [HDR,
      `10.0.0.7,aa:bb:cc:dd:ee:07,01:aa:bb:cc:dd:ee:07,7200,${NOW + 3600},4,1,1,printer,0,,2`,
    ].join('\n');
    expect(parseKeaLeases(csv, NOW)[0]).toMatchObject({
      clientId: '01:aa:bb:cc:dd:ee:07',
      validLifetime: 7200,
      fqdnFwd: true,
      fqdnRev: true,
      poolId: 2,
      userContext: null,
      detailsComplete: true,
    });
  });

  test('obtainedAt is the expiry minus the GRANTED lifetime, not the remaining time', () => {
    // The distinction the detail view depends on: 7200s was granted, 3600s is
    // left, so the client got this an hour ago, not two.
    const csv = [HDR, `10.0.0.8,aa:bb:cc:dd:ee:08,,7200,${NOW + 3600},1,0,0,,0,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0].obtainedAt).toBe(NOW - 3600);
  });

  test('a released lease reports no obtained time rather than a bogus one', () => {
    // lifetime 0 would make the subtraction report the expiry as the start.
    const csv = [HDR, `10.0.0.9,aa:bb:cc:dd:ee:09,,0,${NOW + 3600},1,0,0,,0,,0`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0].obtainedAt).toBe(0);
  });

  test('empty optional columns read as null, not as empty strings', () => {
    const csv = [HDR, `10.0.0.10,aa:bb:cc:dd:ee:10,,3600,${NOW + 60},1,0,0,,0,,`].join('\n');
    expect(parseKeaLeases(csv, NOW)[0]).toMatchObject({
      clientId: null, userContext: null, poolId: null,
    });
  });

  // ── the quoting hazard ─────────────────────────────────────────────────
  //
  // user_context holds Kea's own JSON, which contains commas. A naive
  // split(',') shifts every column after it — and because user_context sits
  // after `state`, that shift was invisible until these fields were read.

  test('a quoted user_context containing commas does not shift pool_id', () => {
    // Written as well-formed CSV: inside a quoted field, each " is doubled.
    // Kea on this deployment writes user_context empty and unquoted, so this
    // guards the format rather than today's data.
    const ctx = '{"ISC":{"client-last-transaction-time":1,"relay-agent-info":"0a"}}';
    const csv = [HDR,
      `10.0.0.11,aa:bb:cc:dd:ee:11,,3600,${NOW + 600},1,0,0,host,0,"${ctx.replace(/"/g, '""')}",5`,
    ].join('\n');
    const l = parseKeaLeases(csv, NOW)[0];
    expect(l.userContext).toBe(ctx);
    expect(l.poolId).toBe(5);          // would be NaN/garbage on a naive split
    expect(l.detailsComplete).toBe(true);
  });

  // ── client-id decoding ─────────────────────────────────────────────────

  test('decodes the real client identifier from this deployment', () => {
    // Verbatim from /var/lib/kea/kea-leases4.csv: a Cisco 3850 naming itself
    // and the VLAN it asked from. The hex tells an operator nothing.
    const cid = '00:63:69:73:63:6f:2d:30:30:64:61:2e:35:35:37:31:2e:64:35:64:64:2d:56:6c:34:34:34';
    const csv = [HDR, `10.0.2.10,00:da:55:71:d5:dd,${cid},3600,${NOW + 600},1,0,0,dhi-3850-asx,0,,0`].join('\n');
    const l = parseKeaLeases(csv, NOW)[0];
    expect(l.clientId).toBe(cid);
    expect(l.clientIdText).toBe('cisco-00da.5571.d5dd-Vl444');
  });

  test('a hardware-type client id decodes to nothing — the MAC column already shows it', () => {
    expect(decodeClientId('01:aa:bb:cc:dd:ee:ff')).toBeNull();
  });

  test('a binary client id is not rendered as control characters', () => {
    expect(decodeClientId('00:01:02:03')).toBeNull();
  });

  test('decodeClientId rejects anything that is not colon-separated hex', () => {
    expect(decodeClientId(null)).toBeNull();
    expect(decodeClientId('')).toBeNull();
    expect(decodeClientId('not-hex')).toBeNull();
    expect(decodeClientId('00')).toBeNull();        // type byte only, no payload
    expect(decodeClientId('00:zz')).toBeNull();
  });

  test('an UNQUOTED comma withholds the shifted fields instead of showing garbage', () => {
    // Nothing can recover the real columns here, so the lease is still listed
    // with its trustworthy fields and the detail view is told not to trust the
    // rest. Showing a shifted pool_id as fact would be worse.
    const csv = [HDR,
      `10.0.0.12,aa:bb:cc:dd:ee:12,,3600,${NOW + 600},1,0,0,host,0,{"a":1,"b":2},5`,
    ].join('\n');
    const l = parseKeaLeases(csv, NOW)[0];
    expect(l.detailsComplete).toBe(false);
    expect(l.poolId).toBeNull();
    expect(l.userContext).toBeNull();
    // The fields before `state` are positionally safe and must survive.
    expect(l).toMatchObject({ ip: '10.0.0.12', mac: 'aa:bb:cc:dd:ee:12', hostname: 'host', state: 'active' });
  });

  test('splitLeaseRow handles quotes, escaped quotes and empty fields', () => {
    expect(splitLeaseRow('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitLeaseRow('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitLeaseRow('a,"say ""hi""",d')).toEqual(['a', 'say "hi"', 'd']);
    expect(splitLeaseRow('a,,c')).toEqual(['a', '', 'c']);
    expect(splitLeaseRow('')).toEqual(['']);
  });

});
