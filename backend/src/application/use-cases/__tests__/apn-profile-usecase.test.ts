// Regression coverage for GitHub issue #30: the APN/DNN Profile object.
import { ApnProfileUseCase, ApnProfileInput } from '../apn-profile-usecase';
import { ApnProfile } from '../../../domain/entities/apn-profile';

const QOS = { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } };

function makeInput(overrides: Partial<ApnProfileInput> = {}): ApnProfileInput {
  return {
    dnn: 'ptt.example.com', dev: 'ptt', subnet: '198.51.100.0/24', gateway: '198.51.100.1',
    qos: QOS, staticRangeStart: null, staticRangeEnd: null, dynamicRangeStart: null, dynamicRangeEnd: null,
    ...overrides,
  };
}

function makeUseCase(opts: {
  profiles?: ApnProfile[];
  smfSessions?: any[];
  upfSessions?: any[];
} = {}) {
  const profiles = opts.profiles ?? [];
  const apnProfileRepo = {
    findAll: jest.fn().mockResolvedValue(profiles),
    findById: jest.fn(async (id: string) => profiles.find((p) => p.id === id) ?? null),
    findByDnn: jest.fn(async (dnn: string) => profiles.find((p) => p.dnn === dnn) ?? null),
    create: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const smfSessions = opts.smfSessions ?? [];
  const upfSessions = opts.upfSessions ?? [];
  const savedSmf: any[] = [];
  const savedUpf: any[] = [];
  const configRepo = {
    loadSmf: jest.fn().mockResolvedValue({ session: smfSessions, rawYaml: { smf: { session: smfSessions } } }),
    loadUpf: jest.fn().mockResolvedValue({ session: upfSessions, rawYaml: { upf: { session: upfSessions } } }),
    saveSmf: jest.fn(async (cfg: any) => { savedSmf.push(cfg); }),
    saveUpf: jest.fn(async (cfg: any) => { savedUpf.push(cfg); }),
  } as any;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const useCase = new ApnProfileUseCase(apnProfileRepo as any, configRepo, logger);
  return { useCase, apnProfileRepo, configRepo, savedSmf, savedUpf };
}

function makeProfile(overrides: Partial<ApnProfile> = {}): ApnProfile {
  const now = new Date().toISOString();
  return {
    id: 'p1', dnn: 'internet', dev: 'ogstun', subnet: '10.45.0.0/24', gateway: '10.45.0.1',
    qos: QOS, staticRangeStart: null, staticRangeEnd: null, dynamicRangeStart: null, dynamicRangeEnd: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe('ApnProfileUseCase.list', () => {
  test('a DNN with a persisted profile is not also listed as derived', async () => {
    const profile = makeProfile();
    const { useCase } = makeUseCase({
      profiles: [profile],
      smfSessions: [{ dnn: 'internet', subnet: '10.45.0.0/24' }],
      upfSessions: [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }],
    });
    const entries = await useCase.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ dnn: 'internet', persisted: true });
  });

  test('a dual-stack DNN\'s derived entry reports the IPv4 gateway, not the v6 one, regardless of iteration order', async () => {
    const { useCase } = makeUseCase({
      smfSessions: [
        { dnn: 'internet', subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
        { dnn: 'internet', subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1' },
      ],
      upfSessions: [
        { dnn: 'internet', subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun' },
        { dnn: 'internet', subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1', dev: 'ogstun' },
      ],
    });
    const entries = await useCase.list();
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).gateway).toBe('10.45.0.1');
  });

  test('a DNN with no persisted profile appears as a derived entry', async () => {
    const { useCase } = makeUseCase({
      smfSessions: [{ dnn: 'ptt.example.com', subnet: '198.51.100.0/24' }],
      upfSessions: [{ subnet: '198.51.100.0/24', dev: 'ptt', gateway: '198.51.100.1' }],
    });
    const entries = await useCase.list();
    expect(entries).toEqual([
      { persisted: false, dnn: 'ptt.example.com', dev: 'ptt', subnet: '198.51.100.0/24', gateway: '198.51.100.1' },
    ]);
  });
});

describe('ApnProfileUseCase.create', () => {
  test('pushes a new smf.yaml/upf.yaml session entry when none exists for the dnn', async () => {
    const { useCase, savedSmf, savedUpf, apnProfileRepo } = makeUseCase();
    const profile = await useCase.create(makeInput());
    expect(profile.dnn).toBe('ptt.example.com');
    expect(apnProfileRepo.create).toHaveBeenCalledWith(expect.objectContaining({ dnn: 'ptt.example.com' }));
    expect(savedSmf[0].rawYaml.smf.session).toEqual([{ subnet: '198.51.100.0/24', gateway: '198.51.100.1', dnn: 'ptt.example.com' }]);
    expect(savedUpf[0].rawYaml.upf.session).toEqual([{ subnet: '198.51.100.0/24', gateway: '198.51.100.1', dev: 'ptt', dnn: 'ptt.example.com' }]);
  });

  test('patches an existing smf.yaml/upf.yaml session entry in place, preserving other fields', async () => {
    const { useCase, savedSmf, savedUpf } = makeUseCase({
      smfSessions: [{ dnn: 'ptt.example.com', subnet: '198.51.100.0/16', gateway: '198.51.100.1', dns: ['10.0.1.180'] }],
      upfSessions: [{ dnn: 'ptt.example.com', subnet: '198.51.100.0/16', gateway: '198.51.100.1', dev: 'ptt' }],
    });
    await useCase.create(makeInput({ subnet: '198.51.100.0/24' }));
    expect(savedSmf[0].rawYaml.smf.session).toHaveLength(1);
    expect(savedSmf[0].rawYaml.smf.session[0]).toMatchObject({ subnet: '198.51.100.0/24', dns: ['10.0.1.180'] });
    expect(savedUpf[0].rawYaml.upf.session).toHaveLength(1);
    expect(savedUpf[0].rawYaml.upf.session[0]).toMatchObject({ subnet: '198.51.100.0/24', dev: 'ptt' });
  });

  test('rejects a duplicate dnn', async () => {
    const { useCase } = makeUseCase({ profiles: [makeProfile({ dnn: 'ptt.example.com' })] });
    await expect(useCase.create(makeInput())).rejects.toThrow(/already exists/);
  });

  test('rejects a static/dynamic range that falls outside the subnet', async () => {
    const { useCase } = makeUseCase();
    await expect(useCase.create(makeInput({
      dynamicRangeStart: '203.0.113.1', dynamicRangeEnd: '203.0.113.254',
    }))).rejects.toThrow(/fall within the pool/);
  });

  test('rejects overlapping static and dynamic ranges', async () => {
    const { useCase } = makeUseCase();
    await expect(useCase.create(makeInput({
      staticRangeStart: '198.51.100.2', staticRangeEnd: '198.51.100.100',
      dynamicRangeStart: '198.51.100.50', dynamicRangeEnd: '198.51.100.254',
    }))).rejects.toThrow(/must not overlap/);
  });

  test('accepts non-overlapping static and dynamic ranges within the subnet', async () => {
    const { useCase } = makeUseCase();
    const profile = await useCase.create(makeInput({
      staticRangeStart: '198.51.100.2', staticRangeEnd: '198.51.100.49',
      dynamicRangeStart: '198.51.100.50', dynamicRangeEnd: '198.51.100.254',
    }));
    expect(profile.dynamicRangeStart).toBe('198.51.100.50');
  });
});

describe('ApnProfileUseCase.createFromDerived', () => {
  test('promotes a derived entry to a persisted profile without touching smf.yaml/upf.yaml', async () => {
    const { useCase, apnProfileRepo, configRepo } = makeUseCase({
      smfSessions: [{ dnn: 'ptt.example.com', subnet: '198.51.100.0/24' }],
      upfSessions: [{ subnet: '198.51.100.0/24', dev: 'ptt', gateway: '198.51.100.1' }],
    });
    const profile = await useCase.createFromDerived('ptt.example.com');
    expect(profile.dnn).toBe('ptt.example.com');
    expect(profile.staticRangeStart).toBeNull();
    expect(profile.dynamicRangeStart).toBeTruthy();
    expect(apnProfileRepo.create).toHaveBeenCalled();
    expect(configRepo.saveSmf).not.toHaveBeenCalled();
    expect(configRepo.saveUpf).not.toHaveBeenCalled();
  });

  test('throws for a dnn that is already a persisted profile', async () => {
    const { useCase } = makeUseCase({
      profiles: [makeProfile({ dnn: 'internet' })],
      smfSessions: [{ dnn: 'internet', subnet: '10.45.0.0/24' }],
      upfSessions: [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }],
    });
    await expect(useCase.createFromDerived('internet')).rejects.toThrow(/No derived/);
  });
});

describe('ApnProfileUseCase.delete', () => {
  test('only removes the Mongo record, never touches config', async () => {
    const { useCase, apnProfileRepo, configRepo } = makeUseCase();
    await useCase.delete('p1');
    expect(apnProfileRepo.delete).toHaveBeenCalledWith('p1');
    expect(configRepo.saveSmf).not.toHaveBeenCalled();
    expect(configRepo.saveUpf).not.toHaveBeenCalled();
  });
});
