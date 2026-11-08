import pino from 'pino';
import { AutoConfigUseCase, AutoConfigInput } from '../auto-config';
import { IHostExecutor, CommandResult } from '../../../domain/interfaces/host-executor';
import { IConfigRepository, AllConfigs } from '../../../domain/interfaces/config-repository';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';

// Regression guard for a real defect reproduced on a clean host 2026-11-07:
// the apply reported
//   success: true, "Restarted: open5gs-mmed, open5gs-sgwud, open5gs-amfd, ..."
// while 4 of those 6 units were dead, because IHostExecutor.executeCommand()
// RESOLVES with { exitCode } on a failed command instead of throwing. The
// old loop was
//
//   try { await executeCommand('systemctl', ['restart', s]);
//         logger.info('Restarted service'); }
//   catch { logger.warn('Failed to restart service'); }
//
// so the catch was dead code for command failure and the exit code was
// discarded. The backend log showed the two adjacent lines for one unit:
//   level=50 "Command execution failed"  ... restart open5gs-upfd
//   level=30 "Restarted service"         ... open5gs-upfd
//
// Mutation check for this file: revert the restart loop to ignore exitCode
// and "reports failure when a restart fails" plus "names only the units that
// really came up" must both fail.

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string): CommandResult => ({ stdout: '', stderr, exitCode: 1 });

/** `ip -o addr show` for a host that holds the addresses the input asks for. */
const IP_ADDR_OK = [
  '1: lo    inet 127.0.0.1/8 scope host lo',
  '2: eth0    inet 172.16.0.171/24 scope global eth0',
  '3: eth1    inet 192.168.253.20/24 scope global eth1',
].join('\n');

function rawCfg(key: string): Record<string, unknown> {
  // Minimal rawYaml shape: each NF's own top-level key must exist so the
  // use case's `raw.<nf>` writes land somewhere.
  return { [key]: {} };
}

function harness(opts: {
  restartResults?: Record<string, CommandResult>;
  ipAddrOutput?: string;
  ipAddrFails?: boolean;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const restartResults = opts.restartResults ?? {};

  const hostExecutor: IHostExecutor = {
    executeCommand: jest.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'ip' && args.includes('addr')) {
        return opts.ipAddrFails
          ? fail('ip: command not found')
          : ok(opts.ipAddrOutput ?? IP_ADDR_OK);
      }
      if (command === 'systemctl' && args[0] === 'restart') {
        return restartResults[args[1]] ?? ok();
      }
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

  const configs = {
    nrf: { rawYaml: { nrf: { serving: [{ plmn_id: { mcc: 999, mnc: 70 } }] } } },
    amf: { rawYaml: rawCfg('amf') },
    smf: { rawYaml: rawCfg('smf') },
    upf: { rawYaml: rawCfg('upf') },
    ausf: { rawYaml: rawCfg('ausf') },
    mme: { rawYaml: rawCfg('mme') },
    sgwc: { rawYaml: rawCfg('sgwc') },
    sgwu: { rawYaml: rawCfg('sgwu') },
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

  const auditEntries: Array<{ success: boolean; details: string }> = [];
  const auditLogger = {
    log: jest.fn(async (e: { success: boolean; details: string }) => {
      auditEntries.push({ success: e.success, details: e.details });
    }),
  } as unknown as IAuditLogger;

  const logger = pino({ level: 'silent' });
  const uc = new AutoConfigUseCase(hostExecutor, configRepo, auditLogger, logger, '/tmp/backups');
  return { uc, calls, auditEntries, configRepo };
}

const INPUT: AutoConfigInput = {
  plmn4g: [{ mcc: '001', mnc: '01', mme_gid: 2, mme_code: 1, tac: 1 }],
  plmn5g: [{ mcc: '001', mnc: '01', tac: 1 }],
  s1mmeIP: '172.16.0.171',
  sgwuGtpIP: '172.16.0.171',
  amfNgapIP: '192.168.253.20',
  upfGtpIP: '192.168.253.20',
  localUpfOnly: true,
  localSgwuOnly: true,
  sessionPools: [{ subnet: '10.45.0.0/16', gateway: '10.45.0.1', dnn: 'internet', dev: 'ogstun' }],
  sessionPoolIPv4Subnet: '10.45.0.0/16',
  sessionPoolIPv4Gateway: '10.45.0.1',
  sessionPoolIPv6Subnet: '2001:db8:cafe::/48',
  sessionPoolIPv6Gateway: '2001:db8:cafe::1',
  configureNAT: false,
};

describe('AutoConfigUseCase restart reporting', () => {
  it('reports success when every restart really succeeded', async () => {
    const { uc } = harness({});
    const r = await uc.execute(INPUT);
    expect(r.success).toBe(true);
    expect(r.errors).toBeUndefined();
  });

  it('reports FAILURE when a restart exits nonzero', async () => {
    const { uc } = harness({
      restartResults: {
        'open5gs-upfd': fail('Job for open5gs-upfd.service failed because the control process exited with error code.'),
      },
    });
    const r = await uc.execute(INPUT);
    expect(r.success).toBe(false);
    expect(r.message).toContain('open5gs-upfd');
    expect(r.errors?.join('\n')).toContain('Job for open5gs-upfd.service failed');
  });

  it('names only the units that really came up, never a failed one, as restarted', async () => {
    const { uc } = harness({
      restartResults: {
        'open5gs-amfd': fail('failed'),
        'open5gs-upfd': fail('failed'),
      },
    });
    const r = await uc.execute(INPUT);
    const restartedClause = /Restarted successfully: ([^.]*)\./.exec(r.message)?.[1] ?? '';
    expect(restartedClause).not.toContain('open5gs-amfd');
    expect(restartedClause).not.toContain('open5gs-upfd');
    expect(restartedClause).toContain('open5gs-smfd');
  });

  it('still reports which files were written, so a partial failure is not read as a no-op', async () => {
    const { uc } = harness({ restartResults: { 'open5gs-upfd': fail('failed') } });
    const r = await uc.execute(INPUT);
    expect(r.success).toBe(false);
    expect(r.updatedFiles.length).toBeGreaterThan(0);
    expect(r.message).toMatch(/Configuration was written/);
  });

  it('offers the backup directory to roll back to on a partial failure', async () => {
    const { uc } = harness({ restartResults: { 'open5gs-upfd': fail('failed') } });
    const r = await uc.execute(INPUT);
    expect(r.backupCreated).toBeTruthy();
    expect(r.message).toContain(r.backupCreated as string);
  });

  it('records the audit entry as unsuccessful when a restart failed', async () => {
    const { uc, auditEntries } = harness({ restartResults: { 'open5gs-mmed': fail('failed') } });
    await uc.execute(INPUT);
    const applyEntry = auditEntries[auditEntries.length - 1];
    expect(applyEntry.success).toBe(false);
    expect(applyEntry.details).toMatch(/failed restart/);
  });

  it('still attempts every remaining restart after one fails', async () => {
    const { uc, calls } = harness({ restartResults: { 'open5gs-mmed': fail('failed') } });
    await uc.execute(INPUT);
    const restarted = calls.filter(c => c.command === 'systemctl' && c.args[0] === 'restart').map(c => c.args[1]);
    // mmed is first in FILE_TO_SERVICE order; the rest must not be skipped.
    expect(restarted).toContain('open5gs-upfd');
    expect(restarted).toContain('open5gs-smfd');
  });
});

describe('AutoConfigUseCase bind-address pre-flight', () => {
  it('refuses an address the host does not hold, and writes nothing', async () => {
    const { uc, calls, configRepo } = harness({});
    const r = await uc.execute({ ...INPUT, amfNgapIP: '10.0.9.155', upfGtpIP: '10.0.9.156' });

    expect(r.success).toBe(false);
    expect(r.updatedFiles).toEqual([]);
    expect(r.message).toContain('10.0.9.155');
    // Nothing saved, and crucially no restart issued.
    expect(configRepo.saveAmf).not.toHaveBeenCalled();
    expect(calls.filter(c => c.command === 'systemctl' && c.args[0] === 'restart')).toHaveLength(0);
  });

  it('does not even create a backup when it refuses', async () => {
    const { uc, calls } = harness({});
    await uc.execute({ ...INPUT, amfNgapIP: '10.0.9.155' });
    expect(calls.filter(c => c.command === 'systemctl')).toHaveLength(0);
  });

  it('records the refusal in the audit log as unsuccessful', async () => {
    const { uc, auditEntries } = harness({});
    await uc.execute({ ...INPUT, amfNgapIP: '10.0.9.155' });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].success).toBe(false);
    expect(auditEntries[0].details).toMatch(/unbindable/i);
  });

  it('proceeds when the host addresses cannot be read, rather than blocking the apply', async () => {
    // A failed `ip addr` must not become an outage of the wizard itself; the
    // restart exit-code check is still a real backstop. Note this input uses
    // addresses that the OK harness holds, but here the probe fails outright
    // so the pre-flight has nothing to compare against and must step aside.
    const { uc, calls } = harness({ ipAddrFails: true });
    const r = await uc.execute({ ...INPUT, amfNgapIP: '10.0.9.155' });
    expect(r.success).toBe(true);
    // It genuinely went on to do the work rather than returning early.
    expect(calls.some(c => c.command === 'systemctl' && c.args[0] === 'restart')).toBe(true);
  });

  it('allows loopback PFCP addresses that never appear in `ip addr`', async () => {
    const { uc } = harness({});
    const r = await uc.execute({
      ...INPUT, localUpfOnly: false, localSgwuOnly: false,
      smfPfcpIP: '127.0.0.4', localUpfPfcpIP: '127.0.0.7', sgwcPfcpIP: '127.0.0.3',
    });
    expect(r.success).toBe(true);
  });
});
