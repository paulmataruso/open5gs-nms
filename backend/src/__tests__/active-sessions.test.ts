/**
 * Unit tests for RAN UE session reporting
 *
 * Tests cover:
 *  - 4G UE detection via MME /ue-info + SMF /pdu-info
 *  - 5G UE detection via SMF /pdu-info + AMF /ue-info + AMF /gnb-info
 *  - Metrics fallback (Prometheus) when JSON APIs return empty
 *  - IMSI field variants (supi vs imsi, prefixed vs bare)
 *  - UE deduplication (5G UE excluded from 4G list)
 *  - Live eNodeB/gNodeB filtering
 *  - Crash guard: missing/undefined supi field
 *  - N2/N3 interface status
 *  - S1-MME / S1-U interface status
 *  - parsePeerIP helper
 */

import pino from 'pino';
import { ActiveSessionsUseCase } from '../application/use-cases/active-sessions';
import { GetInterfaceStatus } from '../application/use-cases/interface-status/get-interface-status';
import { parsePeerIP } from '../application/use-cases/open5gs-api-client';
import type { IHostExecutor } from '../domain/interfaces/host-executor';
import type { IConfigRepository } from '../domain/interfaces/config-repository';
import type { ISubscriberRepository } from '../domain/interfaces/subscriber-repository';

// ── Silent logger for tests ───────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ── Mock factories ────────────────────────────────────────────────────────────

function makeHostExecutor(responses: Record<string, string>): IHostExecutor {
  return {
    executeCommand: jest.fn(async (_cmd: string, args: string[]) => {
      const url = args.find(a => a.startsWith('http')) ?? '';
      const body = responses[url] ?? '';
      return { stdout: body, stderr: '', exitCode: body ? 0 : 1 };
    }),
    isServiceActive:  jest.fn(async () => true),
    isServiceEnabled: jest.fn(async () => true),
    startService:     jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    stopService:      jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    restartService:   jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  } as unknown as IHostExecutor;
}

function makeConfigRepo(): IConfigRepository {
  // Returns minimal YAML configs — no metrics server override so defaults are used
  return {
    loadAmf: jest.fn(async () => ({ rawYaml: {} })),
    loadSmf: jest.fn(async () => ({ rawYaml: {} })),
    loadMme: jest.fn(async () => ({ rawYaml: {} })),
    loadUpf: jest.fn(async () => ({ rawYaml: {} })),
    loadGeneric: jest.fn(async () => ({ rawYaml: {} })),
  } as unknown as IConfigRepository;
}

function makeSubscriberRepo(nicknames: Record<string, string> = {}): ISubscriberRepository {
  return {
    getNicknamesByImsi: jest.fn(async (imsis: string[]) => {
      const result: Record<string, string> = {};
      for (const imsi of imsis) {
        if (nicknames[imsi]) result[imsi] = nicknames[imsi];
      }
      return result;
    }),
  } as unknown as ISubscriberRepository;
}

// ── Default API base URLs (Open5GS defaults) ──────────────────────────────────
const AMF_BASE  = 'http://127.0.0.5:9090';
const MME_BASE  = 'http://127.0.0.2:9090';
const SMF_BASE  = 'http://127.0.0.4:9090';

// ── Sample data builders ──────────────────────────────────────────────────────

function mmeUeInfo(overrides: Record<string, any> = {}) {
  return {
    supi:     '999704281565023',
    domain:   'EPS',
    cm_state: 'connected',
    enb:      { enb_id: 1 },
    pdn:      [{ apn: 'internet', ebi: 5 }],
    ambr:     { downlink: 102400, uplink: 51200 },
    ...overrides,
  };
}

function mmeEnbInfo(overrides: Record<string, any> = {}) {
  return {
    enb_id:            1,
    plmn:              '99970',
    num_connected_ues: 1,
    s1: {
      sctp:          { peer: '[10.0.1.100]:36412' },
      setup_success: true,
    },
    ...overrides,
  };
}

function smfPduSession4G(imsi: string, ip: string) {
  // 4G PDU session — no n3 block
  return {
    supi: `imsi-${imsi}`,
    ue_activity: 'active',
    pdu: [{ ipv4: ip, pdu_state: 'active', apn: 'internet' }],
  };
}

function smfPduSession5G(imsi: string, ip: string, gnbAddr: string) {
  // 5G PDU session — has n3 block
  return {
    supi: `imsi-${imsi}`,
    ue_activity: 'active',
    pdu: [{
      ipv4: ip,
      dnn: 'internet',
      snssai: { sst: 1 },
      pdu_state: 'active',
      n3: {
        gnb: { teid: 1,    addr: `[${gnbAddr}]:2152` },
        upf: { teid: 1001, addr: '[10.0.0.1]:2152'   },
      },
    }],
  };
}

function amfUeInfo(imsi: string, gnbId: number, overrides: Record<string, any> = {}) {
  return {
    supi:     `imsi-${imsi}`,
    cm_state: 'connected',
    gnb:      { gnb_id: gnbId },
    security: { enc: 'NEA2', int: 'NIA2' },
    ambr:     { downlink: 204800, uplink: 102400 },
    ...overrides,
  };
}

function amfGnbInfo(gnbId: number, peerIp: string, setupSuccess = true) {
  return {
    gnb_id:            gnbId,
    plmn:              '99970',
    num_connected_ues: 1,
    ng: {
      sctp:          { peer: `[${peerIp}]:38412` },
      setup_success: setupSuccess,
    },
  };
}

function apiResponse(items: any[]) {
  return JSON.stringify({ items });
}

// ─────────────────────────────────────────────────────────────────────────────
// parsePeerIP
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePeerIP', () => {
  test('parses bracketed IPv4 with port', () => {
    expect(parsePeerIP('[10.0.1.100]:36412')).toBe('10.0.1.100');
  });

  test('parses bracketed IPv6 with port', () => {
    expect(parsePeerIP('[2001:db8::1]:38412')).toBe('2001:db8::1');
  });

  test('parses plain IP:port', () => {
    expect(parsePeerIP('172.16.0.1:36412')).toBe('172.16.0.1');
  });

  test('parses IP without port', () => {
    expect(parsePeerIP('10.0.1.5')).toBe('10.0.1.5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4G UE Sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('getActive4GUEs', () => {
  function makeUseCase(mmeUes: any[], mmeEnbs: any[], pduSessions: any[]) {
    const executor = makeHostExecutor({
      [`${MME_BASE}/ue-info?`]:  apiResponse(mmeUes),
      [`${MME_BASE}/enb-info?`]: apiResponse(mmeEnbs),
      [`${SMF_BASE}/pdu-info?`]: apiResponse(pduSessions),
      // 5G APIs return empty so dedup has nothing to exclude
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    });
    return new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );
  }

  test('returns active 4G UE with IP and IMSI', async () => {
    const ues = await makeUseCase(
      [mmeUeInfo()],
      [mmeEnbInfo()],
      [smfPduSession4G('999704281565023', '10.47.0.1')],
    ).getActive4GUEs();

    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe('999704281565023');
    expect(ues[0].ip).toBe('10.47.0.1');
    expect(ues[0].apn).toBe('internet');
    expect(ues[0].cmState).toBe('connected');
  });

  test('strips imsi- prefix from supi', async () => {
    const ue = mmeUeInfo({ supi: 'imsi-999704281565023' });
    const ues = await makeUseCase([ue], [mmeEnbInfo()], []).getActive4GUEs();
    expect(ues[0].imsi).toBe('999704281565023');
  });

  test('handles bare IMSI supi (no imsi- prefix)', async () => {
    const ues = await makeUseCase(
      [mmeUeInfo({ supi: '999704281565023' })],
      [mmeEnbInfo()],
      [smfPduSession4G('999704281565023', '10.47.0.2')],
    ).getActive4GUEs();
    expect(ues[0].imsi).toBe('999704281565023');
  });

  test('handles missing supi field — uses imsi field fallback', async () => {
    const ue = { ...mmeUeInfo(), supi: undefined, imsi: '999704281565099' };
    const ues = await makeUseCase([ue], [mmeEnbInfo()], []).getActive4GUEs();
    expect(ues[0].imsi).toBe('999704281565099');
  });

  test('skips UE with no supi or imsi — does not crash', async () => {
    const badUe  = { domain: 'EPS', cm_state: 'connected', enb: { enb_id: 1 } };
    const goodUe = mmeUeInfo({ supi: '999704281565001' });
    const ues = await makeUseCase(
      [badUe, goodUe], [mmeEnbInfo()], [],
    ).getActive4GUEs();
    // Bad UE skipped, good UE returned
    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe('999704281565001');
  });

  test('deduplicates — same IMSI appears only once', async () => {
    const ues = await makeUseCase(
      [mmeUeInfo(), mmeUeInfo()],
      [mmeEnbInfo()],
      [smfPduSession4G('999704281565023', '10.47.0.1')],
    ).getActive4GUEs();
    expect(ues).toHaveLength(1);
  });

  test('filters out non-EPS domain UEs', async () => {
    const ue5g = mmeUeInfo({ domain: 'NR', supi: '999704281565099' });
    const ues = await makeUseCase(
      [ue5g, mmeUeInfo()],
      [mmeEnbInfo()],
      [],
    ).getActive4GUEs();
    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe('999704281565023');
  });

  test('shows UEs when eNodeB setup_success is false', async () => {
    // Previous bug: setup_success=false caused liveEnbIps to be empty → all UEs skipped
    const enb = mmeEnbInfo({ s1: { sctp: { peer: '[10.0.1.100]:36412' }, setup_success: false } });
    const ues = await makeUseCase(
      [mmeUeInfo()], [enb], [smfPduSession4G('999704281565023', '10.47.0.1')],
    ).getActive4GUEs();
    expect(ues).toHaveLength(1);
  });

  test('shows UEs when no eNodeB data at all', async () => {
    const ues = await makeUseCase(
      [mmeUeInfo()], [], [smfPduSession4G('999704281565023', '10.47.0.1')],
    ).getActive4GUEs();
    expect(ues).toHaveLength(1);
  });

  test('skips UE whose eNodeB IP is not in live set (stale MME state)', async () => {
    // UE points to enb_id=99 which has no matching live eNodeB
    const ue  = mmeUeInfo({ enb: { enb_id: 99 } });
    const enb = mmeEnbInfo({ enb_id: 1 }); // live, but different enb_id
    // enb_id 99 has no enbIpById entry → radioIp = undefined → UE passes through
    // This is expected — undefined radioIp is not filtered
    const ues = await makeUseCase([ue], [enb], []).getActive4GUEs();
    expect(ues).toHaveLength(1);
  });

  test('returns empty when MME and eNB APIs return nothing and metrics unavailable', async () => {
    const executor = makeHostExecutor({
      [`${AMF_BASE}/ue-info?`]:     apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]:    apiResponse([]),
    });
    const useCase = new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );
    const ues = await useCase.getActive4GUEs();
    expect(ues).toEqual([]);
  });

  test('enriches UE with subscriber nickname', async () => {
    const subRepo = makeSubscriberRepo({ '999704281565023': 'Test Phone' });
    const executor = makeHostExecutor({
      [`${MME_BASE}/ue-info?`]:  apiResponse([mmeUeInfo()]),
      [`${MME_BASE}/enb-info?`]: apiResponse([mmeEnbInfo()]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([smfPduSession4G('999704281565023', '10.47.0.1')]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    });
    const useCase = new ActiveSessionsUseCase(executor, makeConfigRepo(), subRepo, logger);
    const ues = await useCase.getActive4GUEs();
    expect(ues[0].nickname).toBe('Test Phone');
  });

  test('multiple UEs on different eNodeBs', async () => {
    const ue1  = mmeUeInfo({ supi: '111111111111111', enb: { enb_id: 1 } });
    const ue2  = mmeUeInfo({ supi: '222222222222222', enb: { enb_id: 2 } });
    const enb1 = mmeEnbInfo({ enb_id: 1, s1: { sctp: { peer: '[10.0.1.100]:36412' }, setup_success: true } });
    const enb2 = { ...mmeEnbInfo(), enb_id: 2, s1: { sctp: { peer: '[10.0.1.101]:36412' }, setup_success: true } };
    const ues = await makeUseCase(
      [ue1, ue2], [enb1, enb2],
      [smfPduSession4G('111111111111111', '10.47.0.1'), smfPduSession4G('222222222222222', '10.47.0.2')],
    ).getActive4GUEs();
    expect(ues).toHaveLength(2);
    const imsis = ues.map(u => u.imsi).sort();
    expect(imsis).toEqual(['111111111111111', '222222222222222']);
  });

  test('UE without PDU session gets empty IP', async () => {
    const ues = await makeUseCase(
      [mmeUeInfo()], [mmeEnbInfo()], [],
    ).getActive4GUEs();
    expect(ues[0].ip).toBe('');
  });

  // Real-world regression: a VoLTE-capable UE holds two concurrent 4G PDN
  // connections at once — "internet" for data, "ims" for SIP registration.
  // The old code only ever surfaced pdn[0] and silently dropped the rest,
  // so the RAN page's UE tables showed "internet" only, with no sign the
  // "ims" session even existed. Both must show under the SAME row (one UE,
  // one IMSI) via `sessions[]`, not as two separate rows for the same UE.
  test('UE with multiple PDN connections (VoLTE: internet + ims) shows both under one row', async () => {
    const imsi = '999704281565023';
    const ue = mmeUeInfo({ pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }] });
    const smfSession = {
      supi: `imsi-${imsi}`,
      ue_activity: 'active',
      pdu: [
        { ipv4: '10.47.0.1', pdu_state: 'active', apn: 'internet' },
        { ipv4: '10.46.0.5', pdu_state: 'active', apn: 'ims' },
      ],
    };
    const ues = await makeUseCase([ue], [mmeEnbInfo()], [smfSession]).getActive4GUEs();

    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe(imsi);
    // Primary session (index 0) still mirrors ip/apn for backward compat.
    expect(ues[0].apn).toBe('internet');
    expect(ues[0].ip).toBe('10.47.0.1');
    expect(ues[0].sessions).toEqual([
      { apn: 'internet', ip: '10.47.0.1' },
      { apn: 'ims', ip: '10.46.0.5' },
    ]);
  });

  test('re-fetching the same multi-PDN UE does not duplicate the row or its sessions', async () => {
    const imsi = '999704281565023';
    const ue = mmeUeInfo({ pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }] });
    const smfSession = {
      supi: `imsi-${imsi}`,
      ue_activity: 'active',
      pdu: [
        { ipv4: '10.47.0.1', pdu_state: 'active', apn: 'internet' },
        { ipv4: '10.46.0.5', pdu_state: 'active', apn: 'ims' },
      ],
    };
    // Same UE reported twice by the raw MME API (defensive case)
    const ues = await makeUseCase([ue, ue], [mmeEnbInfo()], [smfSession]).getActive4GUEs();
    expect(ues).toHaveLength(1);
    expect(ues[0].sessions).toHaveLength(2);
  });

  test('Prometheus metrics fallback when MME API returns nothing', async () => {
    const prometheusText = [
      '# HELP enb_ue connected UEs',
      '# TYPE enb_ue gauge',
      'enb_ue 3',
      '# HELP mme_session sessions',
      'mme_session 3',
    ].join('\n');

    const executor = makeHostExecutor({
      [`${MME_BASE}/metrics`]:   prometheusText,
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    });
    const useCase = new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );
    const ues = await useCase.getActive4GUEs();
    expect(ues.length).toBe(3);
    expect(ues[0].metricsOnly).toBe(true);
    expect(ues[0].apn).toBe('internet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5G UE Sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('getActive5GUEs', () => {
  function makeUseCase(pduSessions: any[], amfUes: any[], amfGnbs: any[]) {
    const executor = makeHostExecutor({
      [`${SMF_BASE}/pdu-info?`]: apiResponse(pduSessions),
      [`${AMF_BASE}/ue-info?`]:  apiResponse(amfUes),
      [`${AMF_BASE}/gnb-info?`]: apiResponse(amfGnbs),
    });
    return new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );
  }

  test('returns active 5G UE with IP, IMSI, and slice info', async () => {
    const gnbIp = '10.0.1.48';
    const ues = await makeUseCase(
      [smfPduSession5G('999702959493689', '10.45.0.2', gnbIp)],
      [amfUeInfo('999702959493689', 1)],
      [amfGnbInfo(1, gnbIp)],
    ).getActive5GUEs();

    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe('999702959493689');
    expect(ues[0].ip).toBe('10.45.0.2');
    expect(ues[0].dnn).toBe('internet');
    expect(ues[0].sliceSst).toBe(1);
    expect(ues[0].radioIp).toBe(gnbIp);
  });

  test('filters out PDU sessions without N3 block', async () => {
    // 4G-style session with no n3 block — should not appear in 5G list
    const session4G = {
      supi: 'imsi-999704281565023',
      ue_activity: 'active',
      pdu: [{ ipv4: '10.47.0.1', pdu_state: 'active', apn: 'internet' }],
    };
    const ues = await makeUseCase([session4G], [], []).getActive5GUEs();
    expect(ues).toHaveLength(0);
  });

  test('enriches UE with AMF security and AMBR', async () => {
    const gnbIp = '10.0.1.48';
    const ues = await makeUseCase(
      [smfPduSession5G('999702959493689', '10.45.0.2', gnbIp)],
      [amfUeInfo('999702959493689', 1, { security: { enc: 'NEA2', int: 'NIA2' } })],
      [amfGnbInfo(1, gnbIp)],
    ).getActive5GUEs();

    expect(ues[0].securityEnc).toBe('NEA2');
    expect(ues[0].securityInt).toBe('NIA2');
    expect(ues[0].ambrDownlink).toBe(204800);
  });

  test('shows UE when no gNodeB data available', async () => {
    // When amfGnbs is empty, liveGnbIps is empty but hasGnbData is false → pass through
    const ues = await makeUseCase(
      [smfPduSession5G('999702959493689', '10.45.0.2', '10.0.1.48')],
      [amfUeInfo('999702959493689', 1)],
      [],
    ).getActive5GUEs();
    expect(ues).toHaveLength(1);
  });

  test('shows UE when gNodeB setup_success is false', async () => {
    const gnbIp = '10.0.1.48';
    const gnb   = amfGnbInfo(1, gnbIp, false); // setup_success = false
    const ues   = await makeUseCase(
      [smfPduSession5G('999702959493689', '10.45.0.2', gnbIp)],
      [amfUeInfo('999702959493689', 1)],
      [gnb],
    ).getActive5GUEs();
    expect(ues).toHaveLength(1);
  });

  // Same real-world regression as 4G, but for a 5G UE with two concurrent
  // PDU sessions (e.g. "internet" + "ims") to the same gNodeB — both must
  // show under the SAME row (one UE, one IMSI) via `sessions[]`.
  test('UE with multiple PDU sessions (internet + ims) shows both under one row', async () => {
    const imsi = '999702959493689';
    const gnbIp = '10.0.1.48';
    const session = {
      supi: `imsi-${imsi}`,
      ue_activity: 'active',
      pdu: [
        {
          ipv4: '10.45.0.2', dnn: 'internet', snssai: { sst: 1 }, pdu_state: 'active',
          n3: { gnb: { teid: 1, addr: `[${gnbIp}]:2152` }, upf: { teid: 1001, addr: '[10.0.0.1]:2152' } },
        },
        {
          ipv4: '10.46.0.9', dnn: 'ims', snssai: { sst: 1 }, pdu_state: 'active',
          n3: { gnb: { teid: 2, addr: `[${gnbIp}]:2152` }, upf: { teid: 1002, addr: '[10.0.0.1]:2152' } },
        },
      ],
    };
    const ues = await makeUseCase([session], [amfUeInfo(imsi, 1)], [amfGnbInfo(1, gnbIp)]).getActive5GUEs();

    expect(ues).toHaveLength(1);
    expect(ues[0].imsi).toBe(imsi);
    expect(ues[0].dnn).toBe('internet');
    expect(ues[0].ip).toBe('10.45.0.2');
    expect(ues[0].sessions).toEqual([
      { apn: 'internet', ip: '10.45.0.2' },
      { apn: 'ims', ip: '10.46.0.9' },
    ]);
  });

  test('deduplicates by IMSI', async () => {
    const gnbIp = '10.0.1.48';
    const session = smfPduSession5G('999702959493689', '10.45.0.2', gnbIp);
    session.pdu.push({ ...session.pdu[0] }); // duplicate pdu entry
    const ues = await makeUseCase(
      [session, session],
      [amfUeInfo('999702959493689', 1)],
      [amfGnbInfo(1, gnbIp)],
    ).getActive5GUEs();
    expect(ues).toHaveLength(1);
  });

  test('Prometheus metrics fallback when SMF and AMF APIs return nothing', async () => {
    const prometheusText = [
      'ran_ue 2',
      'fivegs_upffunction_upf_sessionnbr 2',
      'fivegs_upffunction_upf_qosflows{dnn="internet"} 2',
    ].join('\n');

    const executor = makeHostExecutor({
      [`${AMF_BASE}/metrics`]: prometheusText,
      [`${SMF_BASE}/metrics`]: prometheusText,
      [`http://127.0.0.7:9090/metrics`]: prometheusText, // UPF
    });
    const useCase = new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );
    const ues = await useCase.getActive5GUEs();
    expect(ues.length).toBeGreaterThan(0);
    expect(ues[0].metricsOnly).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5G/4G deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe('5G/4G deduplication', () => {
  test('UE appearing in 5G list is excluded from 4G list', async () => {
    const imsi   = '999702959493689';
    const gnbIp  = '10.0.1.48';

    const executor = makeHostExecutor({
      [`${SMF_BASE}/pdu-info?`]: apiResponse([
        smfPduSession5G(imsi, '10.45.0.2', gnbIp),  // 5G session
        smfPduSession4G(imsi, '10.47.0.1'),           // 4G session same IMSI
      ]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([amfUeInfo(imsi, 1)]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([amfGnbInfo(1, gnbIp)]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([mmeUeInfo({ supi: imsi })]),
      [`${MME_BASE}/enb-info?`]: apiResponse([mmeEnbInfo()]),
    });

    const useCase = new ActiveSessionsUseCase(
      executor, makeConfigRepo(), makeSubscriberRepo(), logger,
    );

    const [ues5G, ues4G] = await Promise.all([
      useCase.getActive5GUEs(),
      useCase.getActive4GUEs(),
    ]);

    const all = [...ues5G, ...ues4G];
    const imsis = all.map(u => u.imsi);
    // IMSI should appear at most once
    const unique = new Set(imsis);
    expect(unique.size).toBe(imsis.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interface Status (N2, N3, S1-MME, S1-U)
// ─────────────────────────────────────────────────────────────────────────────

describe('GetInterfaceStatus', () => {
  function makeStatus(responses: Record<string, string>) {
    const executor   = makeHostExecutor(responses);
    const subRepo    = makeSubscriberRepo();
    const sessions   = new ActiveSessionsUseCase(executor, makeConfigRepo(), subRepo, logger);
    return new GetInterfaceStatus(executor, logger, sessions, makeConfigRepo());
  }

  test('S1-MME active when eNodeB connected with setup_success=true', async () => {
    const status = await makeStatus({
      [`${MME_BASE}/enb-info?`]: apiResponse([mmeEnbInfo()]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    }).execute();

    expect(status.s1mme.active).toBe(true);
    expect(status.s1mme.connectedEnodebs).toHaveLength(1);
    expect(status.s1mme.connectedEnodebs[0].ip).toBe('10.0.1.100');
    expect(status.s1mme.connectedEnodebs[0].setupSuccess).toBe(true);
  });

  test('S1-MME inactive when no eNodeBs and no metrics', async () => {
    const status = await makeStatus({
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
    }).execute();

    expect(status.s1mme.active).toBe(false);
    expect(status.s1mme.connectedEnodebs).toHaveLength(0);
  });

  test('N2 active when gNodeB connected', async () => {
    const status = await makeStatus({
      [`${AMF_BASE}/gnb-info?`]: apiResponse([amfGnbInfo(1, '10.0.1.48')]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/enb-info?`]: apiResponse([]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([]),
    }).execute();

    expect(status.n2.active).toBe(true);
    expect(status.n2.connectedGnodebs).toHaveLength(1);
    expect(status.n2.connectedGnodebs[0].ip).toBe('10.0.1.48');
  });

  test('N3 active when 5G PDU sessions with N3 blocks exist', async () => {
    const gnbIp = '10.0.1.48';
    const status = await makeStatus({
      [`${SMF_BASE}/pdu-info?`]: apiResponse([smfPduSession5G('999702959493689', '10.45.0.2', gnbIp)]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([amfGnbInfo(1, gnbIp)]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([amfUeInfo('999702959493689', 1)]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/enb-info?`]: apiResponse([]),
    }).execute();

    expect(status.n3.active).toBe(true);
    expect(status.n3.connectedGnodebs).toHaveLength(1);
    expect(status.n3.connectedGnodebs[0].ip).toBe(gnbIp);
    expect(status.n3.connectedGnodebs[0].numConnectedUes).toBe(1);
  });

  test('N3 inactive when no PDU sessions', async () => {
    const status = await makeStatus({
      [`${SMF_BASE}/pdu-info?`]: apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([amfGnbInfo(1, '10.0.1.48')]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/enb-info?`]: apiResponse([]),
    }).execute();

    expect(status.n3.active).toBe(false);
  });

  test('activeUEs4G populated in interface status', async () => {
    const status = await makeStatus({
      [`${MME_BASE}/ue-info?`]:  apiResponse([mmeUeInfo()]),
      [`${MME_BASE}/enb-info?`]: apiResponse([mmeEnbInfo()]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([smfPduSession4G('999704281565023', '10.47.0.1')]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    }).execute();

    expect(status.activeUEs4G).toHaveLength(1);
    expect(status.activeUEs4G[0].imsi).toBe('999704281565023');
    expect(status.activeUEs5G).toHaveLength(0);
  });

  test('activeUEs5G populated in interface status', async () => {
    const gnbIp = '10.0.1.48';
    const status = await makeStatus({
      [`${SMF_BASE}/pdu-info?`]: apiResponse([smfPduSession5G('999702959493689', '10.45.0.2', gnbIp)]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([amfUeInfo('999702959493689', 1)]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([amfGnbInfo(1, gnbIp)]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/enb-info?`]: apiResponse([]),
    }).execute();

    expect(status.activeUEs5G).toHaveLength(1);
    expect(status.activeUEs5G[0].imsi).toBe('999702959493689');
    expect(status.activeUEs4G).toHaveLength(0);
  });

  test('S1-MME Prometheus fallback when JSON API unavailable', async () => {
    const prometheusText = 'enb 2\nenb_ue 4\n';
    const status = await makeStatus({
      [`${MME_BASE}/metrics`]:   prometheusText,
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
    }).execute();

    expect(status.s1mme.active).toBe(true);
    expect(status.s1mme.connectedEnodebs).toHaveLength(2);
    expect(status.s1mme.connectedEnodebs[0].setupSuccess).toBe(true);
  });

  test('N2 Prometheus fallback when JSON API unavailable', async () => {
    const prometheusText = 'gnb 1\nran_ue 2\n';
    const status = await makeStatus({
      [`${AMF_BASE}/metrics`]:   prometheusText,
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${MME_BASE}/enb-info?`]: apiResponse([]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([]),
    }).execute();

    expect(status.n2.active).toBe(true);
    expect(status.n2.connectedGnodebs).toHaveLength(1);
  });

  test('multiple eNodeBs reported correctly', async () => {
    const enbs = [
      mmeEnbInfo({ enb_id: 1, s1: { sctp: { peer: '[10.0.1.100]:36412' }, setup_success: true } }),
      { ...mmeEnbInfo(), enb_id: 2, s1: { sctp: { peer: '[10.0.1.101]:36412' }, setup_success: true } },
      { ...mmeEnbInfo(), enb_id: 3, s1: { sctp: { peer: '[10.0.1.102]:36412' }, setup_success: true } },
    ];
    const status = await makeStatus({
      [`${MME_BASE}/enb-info?`]: apiResponse(enbs),
      [`${MME_BASE}/ue-info?`]:  apiResponse([]),
      [`${SMF_BASE}/pdu-info?`]: apiResponse([]),
      [`${AMF_BASE}/ue-info?`]:  apiResponse([]),
      [`${AMF_BASE}/gnb-info?`]: apiResponse([]),
    }).execute();

    expect(status.s1mme.connectedEnodebs).toHaveLength(3);
    const ips = status.s1mme.connectedEnodebs.map(e => e.ip).sort();
    expect(ips).toEqual(['10.0.1.100', '10.0.1.101', '10.0.1.102']);
  });

  test('all interfaces inactive when all APIs return empty and no metrics', async () => {
    const status = await makeStatus({}).execute();
    expect(status.s1mme.active).toBe(false);
    expect(status.s1u.active).toBe(false);
    expect(status.n2.active).toBe(false);
    expect(status.n3.active).toBe(false);
    expect(status.activeUEs4G).toHaveLength(0);
    expect(status.activeUEs5G).toHaveLength(0);
  });
});
