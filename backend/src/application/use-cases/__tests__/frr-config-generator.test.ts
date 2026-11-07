import * as fs from 'fs';
import * as path from 'path';
import {
  buildFrrConfig, generateOspfConfig, generateZebraFilterConfig,
  liveProtocolOf, transitNetwork, MigrationState, RouteFilter, ServiceMapping,
} from '../frr/frr-config-generator';
import { stripFrrGitSuffix } from '../../../interfaces/rest/frr-controller';

// ── The generated config must describe the router that is actually running ──
//
// These tests exist because the generator and the live host had silently
// diverged for days, in ways that were individually plausible and collectively
// an outage:
//
//  * the stored state said protocol "eigrp" while the host ran OSPF, so
//    regenerating would have written an EIGRP stanza over working OSPF;
//  * the OSPF path emitted `distribute-list route-map NMS_IN in`, which is not
//    a command ospfd has on FRR 10.6.1 at all (its only form is
//    `distribute-list ACCESSLIST4_NAME out <source>` — verified against the
//    binary), so inbound filtering never worked; and
//  * passive interfaces were emitted in the form you TYPE rather than the form
//    ospfd STORES, so a reload wanted to tear down all 14 interface stanzas.
//
// The acceptance bar is `frr-reload.py --test` against the real router showing
// no removals. These tests pin the properties that bar depends on.

const SERVICES: ServiceMapping[] = [
  { service: 'amf', ip: '10.0.1.155', dummyName: 'dummy-amf' },
  { service: 'upf', ip: '10.0.1.156', dummyName: 'dummy-upf' },
];

const FILTERS: RouteFilter[] = [
  { id: 'msc5w6d9', name: 'permit-inbound', direction: 'in', action: 'permit', seq: 20,
    prefixes: ['172.16.1.0/24', '10.0.2.0/24'] },
  { id: 'msc5p70n', name: 'permit-vsi-ips', direction: 'out', action: 'permit', seq: 10,
    prefixes: ['10.0.1.155/32'], description: 'permits VSI /32 service IPs outbound' },
];

const OSPF_CFG = {
  protocol: 'ospf', routerId: '192.168.253.2', area: '0', networkType: 'broadcast',
  redistributeMethod: 'network',
  passiveInterfaces: ['dummy-amf', 'dummy-upf', 'ens18', 'ogstun'],
};

const ospf = (over: Record<string, any> = {}) =>
  generateOspfConfig({ ...OSPF_CFG, ...over }, SERVICES, 'ens20', '192.168.253.0/24',
    '10.6.1', 'open5gs-core', FILTERS, [], 'informational');

describe('OSPF route filtering goes through zebra, never distribute-list', () => {
  test('emits ip protocol ospf route-map and no distribute-list anywhere', () => {
    const out = ospf();
    expect(out).toContain('ip protocol ospf route-map NMS_IN');
    // The load-bearing assertion. ospfd implements only
    // `distribute-list ACCESSLIST4_NAME out <source>` — no `in` direction and
    // no route-map form — so any distribute-list we generate is unparseable,
    // and FRR drops the stanza that carries it.
    expect(out).not.toMatch(/distribute-list/);
  });

  test('the zebra filter generator is protocol-parameterised, not EIGRP-only', () => {
    expect(generateZebraFilterConfig(FILTERS, 'ospf')).toContain('ip protocol ospf route-map NMS_IN');
    expect(generateZebraFilterConfig(FILTERS, 'eigrp')).toContain('ip protocol eigrp route-map NMS_IN');
  });

  test('no filters means no filter block, so NMS_IN is never referenced undefined', () => {
    expect(generateZebraFilterConfig([], 'ospf')).toEqual([]);
    const bare = generateOspfConfig(OSPF_CFG, SERVICES, 'ens20', '192.168.253.0/24',
      '10.6.1', 'h', [], [], 'informational');
    expect(bare).not.toContain('route-map NMS_IN');
    expect(bare).not.toContain('ip protocol ospf route-map');
  });
});

describe('passive interfaces use the form ospfd stores', () => {
  const out = ospf();

  test('rendered as per-interface stanzas, not passive-interface in the process', () => {
    // ospfd keeps the flag on the interface, so running-config always shows
    // `interface X / ip ospf passive`. Emitting the process-level form made
    // frr-reload tear down every interface stanza to re-add the flag the other
    // way — 14 `no interface` lines on the real host.
    expect(out).toContain('interface ogstun\n  ip ospf passive\nexit');
    expect(out).not.toMatch(/^\s*passive-interface /m);
  });

  test('a device that is both operator-passive and a UE pool dev appears once', () => {
    const dup = generateOspfConfig(
      { ...OSPF_CFG, passiveInterfaces: ['ogstun'] }, SERVICES, 'ens20', '192.168.253.0/24',
      '10.6.1', 'h', [], [{ subnet: '10.45.0.0/24', dev: 'ogstun' }], 'informational',
    );
    expect(dup.match(/^interface ogstun$/gm)).toHaveLength(1);
  });
});

describe('the transit interface stanza only exists when it has content', () => {
  test('a broadcast, network-statement deployment emits no transit stanza', () => {
    // `ip ospf network broadcast` is the default and ospfd omits it from
    // running-config; `ip ospf area` is redundant when a `network ... area`
    // statement already covers the interface. Emitting either produced a
    // permanent delta, and an empty `interface ens20 / exit` is itself a
    // stanza frr-reload wants to create.
    expect(ospf()).not.toMatch(/^interface ens20$/m);
  });

  test('a non-default network type is emitted', () => {
    expect(ospf({ networkType: 'point-to-point' }))
      .toContain('interface ens20\n  ip ospf network point-to-point\nexit');
  });

  test('redistribute mode emits ip ospf area, which is required there', () => {
    // Under redistribute there are no network statements at all, so nothing
    // else would enable OSPF on the transit link.
    const out = ospf({ redistributeMethod: 'redistribute' });
    expect(out).toContain('  ip ospf area 0');
    expect(out).not.toMatch(/^\s*network 192\.168\.253\.0\/24 area 0$/m);
    expect(out).toContain('redistribute connected route-map OPEN5GS_SERVICES');
  });
});

describe('transitNetwork', () => {
  test('masks a host address down to its network', () => {
    expect(transitNetwork('192.168.253.2/24')).toBe('192.168.253.0/24');
    expect(transitNetwork('192.168.253.2/30')).toBe('192.168.253.0/30');
  });

  test('a first octet >= 128 does not overflow into a negative Int32', () => {
    // The footgun ip-utils.ts documents: `&` operates on signed Int32, so
    // without `>>> 0` these return garbage.
    expect(transitNetwork('192.168.1.130/25')).toBe('192.168.1.128/25');
    expect(transitNetwork('172.16.5.9/16')).toBe('172.16.0.0/16');
  });

  test('no CIDR falls back rather than emitting NaN', () => {
    expect(transitNetwork(null)).toBe('192.168.253.0/30');
  });
});

describe('buildFrrConfig', () => {
  const state = (over: Partial<MigrationState> = {}): MigrationState => ({
    phase: 'CUTOVER_COMPLETE', protocol: 'ospf', protocolConfig: OSPF_CFG,
    mgmtInterface: 'ens18', transitInterface: 'ens20', transitCidr: '192.168.253.2/24',
    servicePlaneInterface: 'ens19', serviceMappings: SERVICES, routeFilters: FILTERS,
    backupTimestamp: null, log: [], updatedAt: '', logLevel: 'informational', ...over,
  });

  test('OSPF gets the network address, matching what EIGRP already did', () => {
    // The stored CIDR is the HOST address. EIGRP normalised it and OSPF did
    // not, so the same state produced `network 192.168.253.2/24` here and
    // `.0/24` there — and the live router has the network form, so every
    // regeneration looked like a real change.
    const out = buildFrrConfig(state(), { version: '10.6.1', hostname: 'h' });
    expect(out).toContain('  network 192.168.253.0/24 area 0');
    expect(out).not.toContain('  network 192.168.253.2/24 area 0');
  });

  test('an unrenderable state yields empty string, not a partial config', () => {
    // The caller must refuse to write this: truncating frr.conf would leave
    // the router with no routing process at all.
    expect(buildFrrConfig(state({ protocolConfig: null }), { version: '1', hostname: 'h' })).toBe('');
    expect(buildFrrConfig(state({ transitInterface: null }), { version: '1', hostname: 'h' })).toBe('');
  });

  test('an unknown protocol yields empty string rather than a headers-only config', () => {
    expect(buildFrrConfig(state({ protocol: null }), { version: '1', hostname: 'h' })).toBe('');
  });
});

describe('liveProtocolOf — the staleness guard that blocks a regeneration', () => {
  test('reads the running protocol', () => {
    expect(liveProtocolOf('hostname x\nrouter ospf\n network 1.1.1.1/32 area 0\nexit')).toBe('ospf');
    expect(liveProtocolOf('router eigrp 1\nexit')).toBe('eigrp');
    expect(liveProtocolOf('router bgp 65001\nexit')).toBe('bgp');
  });

  test('a config with no routing process returns null, so a first apply is allowed', () => {
    expect(liveProtocolOf('hostname open5gs-core\nend')).toBeNull();
    expect(liveProtocolOf('')).toBeNull();
  });

  test('anchored: free text mentioning a protocol is not the running process', () => {
    // `ip protocol ospf route-map NMS_IN` is a real line in the live config,
    // and a route-map description can contain anything.
    expect(liveProtocolOf('ip protocol ospf route-map NMS_IN\nend')).toBeNull();
    expect(liveProtocolOf(' description link to router bgp 65001\nrouter ospf\nexit')).toBe('ospf');
  });
});

describe('frr-controller routes every frr.conf write through the guard', () => {
  // A structural test, in the spirit of frr-eigrpd-patch-wiring.test.ts: the
  // staleness and empty-config checks live in writeGeneratedFrrConf, and there
  // were EIGHT call sites that would each have had to repeat them. One new
  // write site that skips the helper silently restores the original bug.
  const src = fs.readFileSync(
    path.join(__dirname, '../../../interfaces/rest/frr-controller.ts'), 'utf-8');

  test('exactly one direct write, and it is inside the helper', () => {
    const direct = src.match(/fs\.writeFileSync\(HOST_FRR_CONF/g) ?? [];
    expect(direct).toHaveLength(1);
    const helperStart = src.indexOf('async function writeGeneratedFrrConf');
    const helperEnd = src.indexOf('\n}', helperStart);
    const writeAt = src.indexOf('fs.writeFileSync(HOST_FRR_CONF');
    expect(helperStart).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(helperStart);
    expect(writeAt).toBeLessThan(helperEnd);
  });

  test('the helper checks the live protocol and refuses an empty config', () => {
    const helper = src.slice(
      src.indexOf('async function writeGeneratedFrrConf'),
      src.indexOf('\n}\n', src.indexOf('async function writeGeneratedFrrConf')));
    expect(helper).toContain('frrRegenerationBlocker');
    expect(helper).toMatch(/config\.trim\(\)/);
  });

  test('the helper does not call itself', () => {
    // It did, briefly: a regex rewrite of the call sites also rewrote the write
    // inside the helper, and tsc was perfectly happy with the recursion.
    const helper = src.slice(
      src.indexOf('async function writeGeneratedFrrConf'),
      src.indexOf('\n}\n', src.indexOf('async function writeGeneratedFrrConf')));
    expect(helper).not.toMatch(/await writeGeneratedFrrConf\(/);
  });

  test('the blocker compares stored protocol against the live one', () => {
    expect(src).toContain('liveProtocolOf');
    const blocker = src.slice(src.indexOf('async function frrRegenerationBlocker'));
    expect(blocker.slice(0, 2000)).toMatch(/state\.protocol !== live/);
  });
});

describe('stripFrrGitSuffix — the version line must match running-config exactly', () => {
  // `show version` reports `10.6.1-open5gsnms1-gUNKNOWN`, but
  // `show running-config` renders `frr version 10.6.1-open5gsnms1`. Emitting
  // either the bare `10.6.1` or the full token left a one-line difference that
  // showed up on EVERY regeneration and every frr-reload dry run and could
  // never be resolved — the noise that hides a real pending change.
  test('drops the -g suffix that show version appends', () => {
    expect(stripFrrGitSuffix('10.6.1-open5gsnms1-gUNKNOWN')).toBe('10.6.1-open5gsnms1');
    expect(stripFrrGitSuffix('10.6.1-gab12cd34')).toBe('10.6.1');
  });

  test('keeps a packager suffix, including one that starts with -g', () => {
    // Narrow on purpose: it must not eat a real suffix like `-gnu`.
    expect(stripFrrGitSuffix('10.6.1-open5gsnms1')).toBe('10.6.1-open5gsnms1');
    expect(stripFrrGitSuffix('10.6.1-gnu')).toBe('10.6.1-gnu');
    expect(stripFrrGitSuffix('8.4.4')).toBe('8.4.4');
  });
});
