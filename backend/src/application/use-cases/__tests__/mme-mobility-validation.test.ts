import { validateMmeMobility } from '../mme-mobility-validation';
import { ApplyConfigUseCase } from '../apply-config';
import pino from 'pino';
import { IConfigRepository } from '../../../domain/interfaces/config-repository';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { IAuditLogger } from '../../../domain/interfaces/audit-logger';
import { IWebSocketBroadcaster } from '../../../domain/interfaces/websocket-broadcaster';
import { AllConfigsDto } from '../../dto';
import { ValidateConfigUseCase } from '../validate-config';
import { SyncPrometheusConfigUseCase } from '../sync-prometheus-config';

const neighbor = () => ({ address: '192.0.2.20', port: 2123,
  gummei: { plmn_id: { mcc: '001', mnc: '01' }, mme_gid: 2, mme_code: 2 },
  tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 2 }],
});
const config = (peers: unknown) => ({ mme: { gtpc: { client: { mme: peers } } } });

describe('inter-MME mobility configuration', () => {
  it('supports several neighbors and preserves the distinction between 2/3-digit MNCs', () => {
    const second = neighbor();
    second.gummei.plmn_id.mnc = '001';
    second.tai[0].plmn_id.mnc = '001';
    const peers = validateMmeMobility(config([neighbor(), second]));
    expect(peers.map(p => p.gummei.plmn_id.mnc)).toEqual(['01', '001']);
  });

  it('accepts the parser-supported single-mapping and no-TAI forms', () => {
    expect(validateMmeMobility(config(neighbor()))).toHaveLength(1);
    const { tai, ...idleOnly } = neighbor();
    expect(validateMmeMobility(config([idleOnly]))).toHaveLength(1);
  });

  it.each([
    { port: 0 }, { port: 65536 }, { port: 12.5 }, { address: 'https://mme.example' },
    { address: '999.999.999.999' }, { address: 'a b' }, { address: 'abcd::invalid' },
    { gummei: { plmn_id: { mcc: '01', mnc: '1' }, mme_gid: 2, mme_code: 256 } },
    { tai: [] }, { tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: [1, 2] }] },
    { tai: [{ plmn_id: { mcc: '001', mnc: '01' }, tac: 65536 }] }, { arbitrary: true },
  ])('rejects a value the MME parser cannot safely consume: %j', changes => {
    expect(() => validateMmeMobility(config([{ ...neighbor(), ...changes }]))).toThrow();
  });

  it('accepts IPv6 and DNS peers', () => {
    expect(validateMmeMobility(config([{ ...neighbor(), address: '2001:db8::20' }]))).toHaveLength(1);
    expect(validateMmeMobility(config([{ ...neighbor(), address: 'mme-b.lab.example' }]))).toHaveLength(1);
  });

  it('rejects duplicate identities and ambiguous handover routes', () => {
    expect(() => validateMmeMobility(config([neighbor(), neighbor()]))).toThrow('Duplicate inter-MME neighbor GUMMEI');
    const second = neighbor();
    second.gummei.mme_code = 3;
    expect(() => validateMmeMobility(config([neighbor(), second]))).toThrow('Duplicate inter-MME target TAI route');
  });

  it('rejects routing a local GUMMEI back to itself', () => {
    const value = config([neighbor()]);
    const local = { ...value, mme: { ...value.mme, gummei: [neighbor().gummei] } };
    expect(() => validateMmeMobility(local)).toThrow('different from this MME');
  });
});

describe('apply preflight cannot be bypassed through YAML or the API', () => {
  function setup(status: 'supported' | 'unsupported' | 'unknown', currentMme?: unknown) {
    const backupAll = jest.fn().mockRejectedValue(new Error('stop after preflight'));
    const repo = { loadAll: jest.fn().mockResolvedValue({ mme: { rawYaml: currentMme } }), backupAll } as unknown as IConfigRepository;
    const support = { execute: jest.fn().mockResolvedValue({ status, message: 'Update Open5GS first' }) };
    const apply = new ApplyConfigUseCase(repo, {} as IHostExecutor, {} as IAuditLogger,
      {} as IWebSocketBroadcaster, {} as ValidateConfigUseCase, pino({ level: 'silent' }),
      '/backups', {} as SyncPrometheusConfigUseCase, support);
    return { apply, backupAll, support };
  }

  it.each(['unsupported', 'unknown'] as const)('prevents all writes and restarts when support is %s', async status => {
    const { apply, backupAll } = setup(status);
    const dto = { mme: config([neighbor()]) } as unknown as AllConfigsDto;
    await expect(apply.execute(dto)).rejects.toThrow('Update Open5GS first');
    expect(backupAll).not.toHaveBeenCalled();
  });

  it('allows a supported configuration to enter the existing backup/apply workflow', async () => {
    const { apply, backupAll } = setup('supported');
    await expect(apply.execute({ mme: config([neighbor()]) } as unknown as AllConfigsDto)).rejects.toThrow('stop after preflight');
    expect(backupAll).toHaveBeenCalledTimes(1);
  });

  it('allows clearing all neighbors on an older MME', async () => {
    const { apply, backupAll, support } = setup('unsupported');
    await expect(apply.execute({ mme: config([]) } as unknown as AllConfigsDto)).rejects.toThrow('stop after preflight');
    expect(support.execute).not.toHaveBeenCalled();
    expect(backupAll).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed neighbors before either detection or backup', async () => {
    const { apply, backupAll, support } = setup('supported');
    await expect(apply.execute({ mme: config([{ ...neighbor(), port: 0 }]) } as unknown as AllConfigsDto)).rejects.toThrow('Invalid inter-MME');
    expect(support.execute).not.toHaveBeenCalled();
    expect(backupAll).not.toHaveBeenCalled();
  });

  it('checks retained neighbors when a partial API request omits them', async () => {
    const { apply, backupAll, support } = setup('unsupported', config([neighbor()]));
    await expect(apply.execute({ mme: { mme: { mme_name: 'renamed' } } } as unknown as AllConfigsDto)).rejects.toThrow('Update Open5GS first');
    expect(support.execute).toHaveBeenCalled();
    expect(backupAll).not.toHaveBeenCalled();
  });
});
