import * as jsyaml from 'js-yaml';
import {
  buildGnbYaml, buildUeYaml, buildEnbConf, buildRrConf, buildUeConf,
  allocateRadioDummyIp, type InferredConfig,
} from '../validation-controller';

/**
 * The simulated RAN's generated configs (UERANSIM 5G, srsRAN 4G).
 *
 * These five generators turn this deployment's real core config into the
 * configs a simulated gNB/eNB/UE boots from. They had no tests, and several
 * carry values that were arrived at by reproducing a live failure -- the kind
 * that a later tidy-up silently undoes, because the wrong value still boots
 * and still looks plausible.
 *
 * Unlike the other golden-master suites here, there is no live file to diff
 * against: these are written per validation session into a container's config
 * dir and thrown away. So the fidelity assertion is against the real INPUT
 * instead -- the InferredConfig below was captured from this host's running
 * API (GET /api/validation/infer, 2026-11-28), not transcribed, so what the
 * generators are asked to render is exactly what the live core says.
 *
 * inferConfig() itself is not re-tested here; infer-config-plmn-width.test.ts
 * owns the YAML-reading half.
 */

/** Captured verbatim from GET /api/validation/infer on this deployment. */
const LIVE: InferredConfig = {
  plmn: { mcc: '001', mnc: '01' },
  amfIp: '10.0.1.155',
  upfIp: '10.0.1.156',
  tac5g: 1,
  slices: [{ sst: 1, sd: '19cde1' }, { sst: 1 }],
  dnns: ['internet', 'ims'],
  subnets: [
    { dnn: 'internet', cidr: '10.45.0.0/24', gateway: '10.45.0.1' },
    { dnn: 'internet', cidr: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' },
    { dnn: 'ims', cidr: '10.46.0.0/24', gateway: '10.46.0.1' },
  ],
  mmeIp: '10.0.1.175',
  tac4g: 1,
  mmeGroupId: 2,
  mmeCode: 1,
  apns: ['internet', 'ims'],
};

const NO_PARAMS = {};
/** A test IMSI/key triple -- never a real subscriber's. */
const TEST_IMSI = '001010000000001';
const TEST_K = '00112233445566778899aabbccddeeff';
const TEST_OPC = 'ffeeddccbbaa99887766554433221100';

type GnbDoc = {
  mcc: string; mnc: string; nci: string; tac: number;
  linkIp: string; ngapIp: string; gtpIp: string;
  amfConfigs: { address: string; port: number }[];
  slices: { sst: number; sd?: number }[];
};

describe('gnb.yaml (UERANSIM)', () => {
  const doc = (idx: number, ngapIp: string): GnbDoc =>
    jsyaml.load(buildGnbYaml(idx, LIVE, NO_PARAMS, ngapIp)) as GnbDoc;

  it('carries the live PLMN with its real MNC WIDTH intact', () => {
    // 70 is not 070 and 01 is not 001: the MNC's width is part of the network
    // identity, and three separate test-IMSI builders in this repo have
    // conflated them before -- one put subscribers in PLMN 001-001 on a
    // 001-01 host. The strings must survive as strings.
    const d = doc(0, '10.0.9.1');
    expect(d.mcc).toBe('001');
    expect(d.mnc).toBe('01');
  });

  it('converts the slice sd from its hex STRING to an integer', () => {
    // Open5GS writes sd as hex text (`19cde1` live); UERANSIM's own config
    // wants a number. Handing it the string is the plausible-looking bug --
    // it serialises fine and the gNB then registers with the wrong, or no,
    // slice.
    const d = doc(0, '10.0.9.1');
    expect(d.slices).toEqual([{ sst: 1, sd: 0x19cde1 }]);
    expect(d.slices[0].sd).toBe(1691105);
  });

  it('omits sd entirely for a slice that has none', () => {
    // `sd: undefined` would serialise, and a literal null sd is not the same
    // as an absent one to UERANSIM.
    const single: InferredConfig = { ...LIVE, slices: [{ sst: 1 }] };
    const d = jsyaml.load(buildGnbYaml(0, single, NO_PARAMS, '10.0.9.1')) as GnbDoc;
    expect(d.slices).toEqual([{ sst: 1 }]);
    expect(Object.prototype.hasOwnProperty.call(d.slices[0], 'sd')).toBe(false);
  });

  it('points at the live AMF, and lets a caller override it', () => {
    expect(doc(0, '10.0.9.1').amfConfigs).toEqual([{ address: '10.0.1.155', port: 38412 }]);
    const over = jsyaml.load(
      buildGnbYaml(0, LIVE, { amfIp: '10.0.1.200' }, '10.0.9.1'),
    ) as GnbDoc;
    expect(over.amfConfigs).toEqual([{ address: '10.0.1.200', port: 38412 }]);
  });

  it('uses the per-gNB dummy /32 for NGAP, never loopback and never the AMF', () => {
    // The documented reason, and both halves matter: SCTP cannot route from a
    // loopback source, and Open5GS keys gNB identity by PEER IP -- so reusing
    // the AMF's own address makes every gNB indistinguishable and the second
    // connection is rejected outright.
    const d = doc(0, '10.0.9.1');
    expect(d.ngapIp).toBe('10.0.9.1');
    expect(d.ngapIp).not.toBe(LIVE.amfIp);
    expect(d.ngapIp.startsWith('127.')).toBe(false);
  });

  it('keeps the user-plane on loopback, with linkIp and gtpIp equal', () => {
    // 127.0.3.x is deliberate: all of 127/8 routes to lo without an alias,
    // nothing in Open5GS uses that range so :2152 is free, and the UPF is on
    // this same host so it can route back.
    const d = doc(0, '10.0.9.1');
    expect(d.linkIp).toBe('127.0.3.1');
    expect(d.gtpIp).toBe(d.linkIp);
  });

  it('gives each gNB a distinct 9-digit NCI', () => {
    // Two gNBs sharing an NCI is the same identity collision as sharing an IP.
    expect(doc(0, '10.0.9.1').nci).toBe('0x000000001');
    expect(doc(1, '10.0.9.2').nci).toBe('0x000000002');
    const ncis = [0, 1, 2, 3].map((i) => doc(i, `10.0.9.${i + 1}`).nci);
    expect(new Set(ncis).size).toBe(4);
    for (const n of ncis) expect(n).toMatch(/^0x[0-9a-f]{9}$/);
  });

  it('carries the live 5G TAC', () => {
    expect(doc(0, '10.0.9.1').tac).toBe(1);
  });
});

describe('enb.conf (srsRAN)', () => {
  const conf = (idx: number, s1c: string): string =>
    buildEnbConf(idx, LIVE, NO_PARAMS, s1c);
  const val = (c: string, key: string): string => {
    const m = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(c);
    if (!m) throw new Error(`no ${key} in enb.conf`);
    return m[1];
  };

  it('keeps n_prb at 25, because a 6-PRB cell cannot page at all', () => {
    // This was 6 on the reasoning that attach validation only needs enough
    // PRBs for NAS. That missed idle-mode paging: a 6-PRB cell's PDCCH/PUCCH
    // is too narrow to fit a Paging message, reproduced live as "Could not
    // allocate Paging ... No space available in PUCCH or PDCCH" with the MME
    // retrying S1AP Paging three times and giving up every time. 25 is the
    // next standard step up and costs ~3x the CPU rather than 50's ~10x.
    //
    // Pinned because 6 still boots, still attaches, and only fails the one
    // thing nobody tests by hand.
    expect(val(conf(0, '10.0.9.1'), 'n_prb')).toBe('25');
  });

  it('binds S1-C to the per-eNB dummy /32, never 0.0.0.0', () => {
    // 0.0.0.0 looks like the obvious default and is the bug: the kernel
    // resolves it to the host's one real IP for an outbound connection -- the
    // same IP the MME listens on -- and Open5GS rejects a second peer from a
    // duplicate address, so simulated eNBs collided with each other and with
    // the MME.
    const c = conf(0, '10.0.9.5');
    expect(val(c, 's1c_bind_addr')).toBe('10.0.9.5');
    expect(c).not.toContain('s1c_bind_addr = 0.0.0.0');
  });

  it('points at the live MME and PLMN', () => {
    const c = conf(0, '10.0.9.1');
    expect(val(c, 'mme_addr')).toBe('10.0.1.175');
    expect(val(c, 'mcc')).toBe('001');
    expect(val(c, 'mnc')).toBe('01');
  });

  it('gives each eNB a distinct hex id and a non-overlapping port pair', () => {
    // Two concurrent sessions on one host must not contend for the same ZMQ
    // ports, and a duplicate enb_id is another identity collision.
    const ids = [0, 1, 2].map((i) => val(conf(i, '10.0.9.1'), 'enb_id'));
    expect(ids).toEqual(['0x001', '0x002', '0x003']);
    const ports = [0, 1, 2].flatMap((i) => {
      const c = conf(i, '10.0.9.1');
      return [...c.matchAll(/tx_port=tcp:\/\/\*:(\d+)|rx_port=tcp:\/\/[^:]+:(\d+)/g)]
        .map((m) => m[1] ?? m[2]);
    });
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('keeps the user-plane GTP on its own loopback alias', () => {
    expect(val(conf(0, '10.0.9.1'), 'gtp_bind_addr')).toBe('127.0.4.1');
  });
});

describe('rr.conf (srsRAN radio resources)', () => {
  it('renders the live 4G TAC as 4-digit hex', () => {
    // srsenb wants 0x-prefixed hex here; a bare decimal is a different TAC
    // and the eNB would attach to a tracking area the MME does not serve.
    expect(buildRrConf(LIVE)).toContain('tac = 0x0001');
  });

  it('pads a wider TAC rather than truncating it', () => {
    expect(buildRrConf({ ...LIVE, tac4g: 0xabcd })).toContain('tac = 0xabcd');
    expect(buildRrConf({ ...LIVE, tac4g: 7 })).toContain('tac = 0x0007');
  });
});

describe('ue.conf / ue.yaml (the simulated handsets)', () => {
  it('writes the IMSI, key and OPc it was handed, unmodified', () => {
    // A mangled key fails authentication with a MAC failure, which reads as a
    // core/HSS problem rather than a generator problem.
    const c = buildUeConf(TEST_IMSI, TEST_K, TEST_OPC, 0, LIVE, NO_PARAMS);
    expect(c).toContain(TEST_IMSI);
    expect(c).toContain(TEST_K);
    expect(c).toContain(TEST_OPC);
  });

  it('prefixes the 5G UE supi correctly and keeps the PLMN width', () => {
    const d = jsyaml.load(
      buildUeYaml(TEST_IMSI, TEST_K, TEST_OPC, '127.0.3.1', LIVE, NO_PARAMS),
    ) as {
      supi: string; mcc: string; mnc: string; key: string; op: string;
      opType: string; imei: string; gnbSearchList: string[];
      sessions: { type: string; apn: string; slice: Record<string, number> }[];
    };
    expect(d.supi).toBe(`imsi-${TEST_IMSI}`);
    expect(d.mcc).toBe('001');
    expect(d.mnc).toBe('01');
    // The key goes in as `key`/`op` with opType OPC -- feeding an OPc into a
    // field read as OP authenticates against a different derived K and fails
    // with a MAC failure, which reads as an HSS fault.
    expect(d.key).toBe(TEST_K);
    expect(d.op).toBe(TEST_OPC);
    expect(d.opType).toBe('OPC');
    expect(d.gnbSearchList).toEqual(['127.0.3.1']);
  });

  it('defaults the session APN to the live first DNN, and honours an override', () => {
    const load = (params: Record<string, string>): { apn: string } =>
      (jsyaml.load(buildUeYaml(TEST_IMSI, TEST_K, TEST_OPC, '127.0.3.1', LIVE, params)) as {
        sessions: { apn: string }[];
      }).sessions[0];
    expect(load({}).apn).toBe('internet');
    expect(load({ dnn: 'ims' }).apn).toBe('ims');
  });

  it('generates a 15-digit IMEI, fresh each call', () => {
    // Random by design, so this file can never be byte-goldened -- worth
    // stating, since every other generated config here can be.
    const imei = (): string =>
      (jsyaml.load(buildUeYaml(TEST_IMSI, TEST_K, TEST_OPC, '127.0.3.1', LIVE, NO_PARAMS)) as {
        imei: string;
      }).imei;
    const a = imei();
    expect(a).toMatch(/^35\d{13}$/);
    expect(new Set([a, imei(), imei(), imei(), imei()]).size).toBeGreaterThan(1);
  });
});

describe('allocateRadioDummyIp', () => {
  it('hands every radio in one session its own address', () => {
    const got = [
      allocateRadioDummyIp('s1', '4g', 0), allocateRadioDummyIp('s1', '4g', 1),
      allocateRadioDummyIp('s1', '5g', 0), allocateRadioDummyIp('s1', '5g', 1),
    ];
    expect(new Set(got.map((g) => g.ip)).size).toBe(4);
    expect(new Set(got.map((g) => g.name)).size).toBe(4);
  });

  it('derives the IP from (kind, index) ONLY — the session id is in the NAME', () => {
    // Worth stating plainly because the opposite is the natural assumption:
    // two sessions asking for the same kind and index get the SAME address,
    // and only the interface name distinguishes them. That is what the sizing
    // below relies on -- the ranges are cut for one session's worst case, not
    // for several at once.
    expect(allocateRadioDummyIp('s1', '4g', 0).ip)
      .toBe(allocateRadioDummyIp('s2', '4g', 0).ip);
    expect(allocateRadioDummyIp('s1', '4g', 0).name)
      .not.toBe(allocateRadioDummyIp('s2', '4g', 0).name);
  });

  it('keeps the 4G and 5G ranges apart, and the UI cap is what keeps them apart', () => {
    // 4G runs 10.0.9.10 .. .109 and 5G starts at .110, directly above it.
    // There is NO bounds check in the allocator, so the separation rests
    // entirely on the UI's documented maximum of 100 eNBs (10x10). Raise that
    // cap and eNB 100 lands on 10.0.9.110, which is gNB 0 -- two radios on one
    // address, which is the identity collision the dummy /32 exists to avoid
    // in the first place. Pinned so the boundary is visible from the test
    // rather than only from a comment.
    expect(allocateRadioDummyIp('s1', '4g', 0).ip).toBe('10.0.9.10');
    expect(allocateRadioDummyIp('s1', '4g', 99).ip).toBe('10.0.9.109');
    expect(allocateRadioDummyIp('s1', '5g', 0).ip).toBe('10.0.9.110');
    expect(allocateRadioDummyIp('s1', '5g', 19).ip).toBe('10.0.9.129');
    // The documented worst case fits with nothing overlapping.
    const fourG = new Set(Array.from({ length: 100 }, (_, i) => allocateRadioDummyIp('s', '4g', i).ip));
    const fiveG = new Set(Array.from({ length: 20 }, (_, i) => allocateRadioDummyIp('s', '5g', i).ip));
    expect(fourG.size).toBe(100);
    expect([...fourG].filter((ip) => fiveG.has(ip))).toEqual([]);
    // ...and one past it does not.
    expect(allocateRadioDummyIp('s', '4g', 100).ip).toBe(allocateRadioDummyIp('s', '5g', 0).ip);
  });

  it('names interfaces so the sweep regex can find them later', () => {
    // force-cleanup finds leftovers by name alone (/^v[45]-[0-9a-f]{6}-\d+$/),
    // whether or not a session record survives, so a name that does not match
    // leaks a host interface on every crashed run.
    for (const kind of ['4g', '5g'] as const) {
      expect(allocateRadioDummyIp('abc123def', kind, 7).name).toMatch(/^v[45]-[0-9a-f]{6}-\d+$/);
    }
    expect(allocateRadioDummyIp('abc123def', '4g', 7).name).toBe('v4-abc123-7');
    expect(allocateRadioDummyIp('abc123def', '5g', 7).name).toBe('v5-abc123-7');
  });
});
