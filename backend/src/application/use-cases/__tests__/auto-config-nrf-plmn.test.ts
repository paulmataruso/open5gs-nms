import pino from 'pino';
import { AutoConfigUseCase, AutoConfigInput } from '../auto-config';
import { IHostExecutor, CommandResult } from '../../../domain/interfaces/host-executor';
import { IConfigRepository, AllConfigs } from '../../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';

// Regression guard for a real clean-host failure, 2026-11-08: 5G registration
// did not work at all on a fresh install.
//
// nrf.yaml carries its own `nrf.serving[].plmn_id`, shipped as Open5GS's stock
// test PLMN 999/70. The Auto-Config wizard wrote amf/mme/smf/upf/sgwc/sgwu and
// never nrf.yaml, so every NF ended up on the operator's PLMN while the NRF
// still served 999/70. NF-Discover then failed inside the NRF itself
// ({"title":"server callback error","status":500}), the SCP turned that into a
// 400 to the AMF, and every UE got `Registration reject [95]` — a chain that
// names neither the NRF nor the PLMN.
//
// Confirmed live both ways: with nrf.yaml stale, two UERANSIM UEs were
// rejected on every attempt; with it corrected, both reached
// `Registration complete` and an established PDU session.

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const IP_ADDR = '2: eth0    inet 172.16.0.171/24 scope global eth0';

function harness() {
  const hostExecutor: IHostExecutor = {
    executeCommand: jest.fn(async (command: string, args: string[]) => {
      if (command === 'ip' && args.includes('addr')) return ok(IP_ADDR);
      return ok();
    }),
    executeLocalCommand: jest.fn(async () => ok()),
    readFile: jest.fn(async () => ''),
    writeFile: jest.fn(async () => undefined),
    fileExists: jest.fn(async () => false),
    copyFile: jest.fn(async () => undefined),
    createDirectory: jest.fn(async () => undefined),
    listDirectory: jest.fn(async () => []),
    restartService: jest.fn(async () => ok()),
    startService: jest.fn(async () => ok()),
    stopService: jest.fn(async () => ok()),
    getServiceStatus: jest.fn(async () => ok()),
    isServiceActive: jest.fn(async () => true),
    isServiceEnabled: jest.fn(async () => true),
    enableService: jest.fn(async () => ok()),
    disableService: jest.fn(async () => ok()),
    isPortListening: jest.fn(async () => false),
  };

  // Stock Open5GS nrf.yaml: serving PLMN is the 999/70 test network.
  const nrf = { rawYaml: { nrf: { serving: [{ plmn_id: { mcc: 999, mnc: 70 } }] } } };
  const configs = {
    nrf,
    amf: { rawYaml: { amf: {} } },
    smf: { rawYaml: { smf: {} } },
    upf: { rawYaml: { upf: {} } },
    ausf: { rawYaml: { ausf: {} } },
    mme: { rawYaml: { mme: {} } },
    sgwc: { rawYaml: { sgwc: {} } },
    sgwu: { rawYaml: { sgwu: {} } },
  } as unknown as AllConfigs;

  const configRepo = {
    loadAll: jest.fn(async () => configs),
    saveNrf: jest.fn(async () => undefined),
    saveMme: jest.fn(async () => undefined),
    saveAmf: jest.fn(async () => undefined),
    saveSmf: jest.fn(async () => undefined),
    saveUpf: jest.fn(async () => undefined),
    saveSgwc: jest.fn(async () => undefined),
    saveSgwu: jest.fn(async () => undefined),
  } as unknown as IConfigRepository;

  const auditLogger = { log: jest.fn(async () => undefined) } as unknown as IAuditLogger;
  const uc = new AutoConfigUseCase(
    hostExecutor, configRepo, auditLogger, pino({ level: 'silent' }), '/tmp/b',
  );
  return { uc, configRepo, hostExecutor, nrf };
}

const INPUT: AutoConfigInput = {
  plmn4g: [{ mcc: '001', mnc: '01', mme_gid: 2, mme_code: 1, tac: 1 }],
  plmn5g: [{ mcc: '001', mnc: '01', tac: 1 }],
  s1mmeIP: '172.16.0.171', sgwuGtpIP: '172.16.0.171',
  amfNgapIP: '172.16.0.171', upfGtpIP: '172.16.0.171',
  localUpfOnly: true, localSgwuOnly: true,
  sessionPools: [{ subnet: '10.45.0.0/16', gateway: '10.45.0.1', dnn: 'internet', dev: 'ogstun' }],
  sessionPoolIPv4Subnet: '10.45.0.0/16', sessionPoolIPv4Gateway: '10.45.0.1',
  sessionPoolIPv6Subnet: '2001:db8:cafe::/48', sessionPoolIPv6Gateway: '2001:db8:cafe::1',
  configureNAT: false,
};

describe('AutoConfigUseCase NRF serving PLMN', () => {
  it('rewrites nrf.yaml away from the stock 999/70 test PLMN', async () => {
    const { uc, nrf } = harness();
    const r = await uc.execute(INPUT);
    expect(r.success).toBe(true);
    expect((nrf.rawYaml as never as { nrf: { serving: unknown } }).nrf.serving)
      .toEqual([{ plmn_id: { mcc: '001', mnc: '01' } }]);
  });

  it('saves and reports nrf.yaml as an updated file', async () => {
    const { uc, configRepo } = harness();
    const r = await uc.execute(INPUT);
    expect(configRepo.saveNrf).toHaveBeenCalled();
    expect(r.updatedFiles).toContain('nrf.yaml');
  });

  it('restarts open5gs-nrfd so the new serving PLMN takes effect', async () => {
    const { uc, hostExecutor } = harness();
    await uc.execute(INPUT);
    const calls = (hostExecutor.executeCommand as jest.Mock).mock.calls;
    const restarted = calls
      .filter(c => c[0] === 'systemctl' && c[1][0] === 'restart')
      .map(c => c[1][1]);
    expect(restarted).toContain('open5gs-nrfd');
  });

  it('writes every PLMN when several are configured', async () => {
    const { uc, nrf } = harness();
    await uc.execute({
      ...INPUT,
      plmn5g: [{ mcc: '001', mnc: '01', tac: 1 }, { mcc: '310', mnc: '410', tac: 2 }],
    });
    expect((nrf.rawYaml as never as { nrf: { serving: unknown[] } }).nrf.serving).toHaveLength(2);
  });

  it('falls back to the 4G PLMN list when no 5G PLMN is configured', async () => {
    // A 4G-only deployment still runs the 5G SBI NFs, so an empty serving
    // list would leave the same discovery failure in place.
    const { uc, nrf } = harness();
    await uc.execute({ ...INPUT, plmn5g: [] });
    expect((nrf.rawYaml as never as { nrf: { serving: unknown } }).nrf.serving)
      .toEqual([{ plmn_id: { mcc: '001', mnc: '01' } }]);
  });

  it('leaves nrf.yaml alone when the PLMN card is unchecked', async () => {
    const { uc, configRepo, nrf } = harness();
    const r = await uc.execute({ ...INPUT, applyPlmn: false });
    expect(configRepo.saveNrf).not.toHaveBeenCalled();
    expect(r.updatedFiles).not.toContain('nrf.yaml');
    expect((nrf.rawYaml as never as { nrf: { serving: unknown } }).nrf.serving)
      .toEqual([{ plmn_id: { mcc: 999, mnc: 70 } }]);
  });

  it('backs nrf.yaml up before touching it', async () => {
    const { uc, hostExecutor } = harness();
    await uc.execute(INPUT);
    const copied = (hostExecutor.copyFile as jest.Mock).mock.calls.map(c => c[0]);
    expect(copied).toContain('/etc/open5gs/nrf.yaml');
  });
});
