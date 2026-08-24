// Regression coverage for GitHub issue #30's Part B: AutoAssignIPsUseCase
// respecting an ApnProfile's static/dynamic split.
import { AutoAssignIPsUseCase } from '../auto-assign-ips-usecase';

const UPF_SESSION = [{ subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun', dnn: 'internet' }];

function makeSubscriber(imsi: string, ipv4?: string): any {
  return {
    imsi,
    slice: [{ session: [{ name: 'internet', ue: ipv4 ? { ipv4 } : {} }] }],
  };
}

function makeUseCase(opts: { subscribers?: any[]; internetProfile?: any } = {}) {
  const subscribers = opts.subscribers ?? [];
  const subscriberRepo = {
    findAllFull: jest.fn().mockResolvedValue(subscribers),
    assignIPv4ByApn: jest.fn().mockResolvedValue(undefined),
  } as any;
  const configRepo = {
    loadUpf: jest.fn().mockResolvedValue({ rawYaml: { upf: { session: UPF_SESSION } } }),
    loadSmf: jest.fn().mockResolvedValue({ rawYaml: { smf: { session: [] } } }),
  } as any;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const apnProfileRepo = opts.internetProfile !== undefined ? {
    findByDnn: jest.fn(async (dnn: string) => (dnn === 'internet' ? opts.internetProfile : null)),
  } as any : undefined;
  return { useCase: new AutoAssignIPsUseCase(subscriberRepo, configRepo, logger, apnProfileRepo), subscriberRepo };
}

describe('AutoAssignIPsUseCase — #30 dynamic-range integration', () => {
  test('getPoolInfo: no apnProfileRepo passed — identical to pre-#30 behavior, no dynamic range fields', async () => {
    const { useCase } = makeUseCase();
    const info = await useCase.getPoolInfo();
    expect(info.ipPool).toBe('10.45.0.0/24');
    expect(info.startIp).toBe('10.45.0.1');
    expect(info.dynamicRangeStart).toBeUndefined();
  });

  test('getPoolInfo: apnProfileRepo present but no profile for "internet" — same as no dynamic range', async () => {
    const { useCase } = makeUseCase({ internetProfile: null });
    const info = await useCase.getPoolInfo();
    expect(info.dynamicRangeStart).toBeUndefined();
  });

  test('getPoolInfo: a persisted profile with a dynamic range reports it', async () => {
    const { useCase } = makeUseCase({
      internetProfile: { dynamicRangeStart: '10.45.0.50', dynamicRangeEnd: '10.45.0.200' },
    });
    const info = await useCase.getPoolInfo();
    expect(info.dynamicRangeStart).toBe('10.45.0.50');
    expect(info.dynamicRangeEnd).toBe('10.45.0.200');
    // the whole-pool fields are untouched — both are reported, not one replacing the other
    expect(info.startIp).toBe('10.45.0.1');
  });

  test('execute: no profile — assigns from the whole pool, unchanged from before #30', async () => {
    const { useCase, subscriberRepo } = makeUseCase({
      subscribers: [makeSubscriber('001', undefined)],
    });
    await useCase.execute();
    expect(subscriberRepo.assignIPv4ByApn).toHaveBeenCalledWith('001', 'internet', '10.45.0.2');
  });

  test('execute: a profile\'s dynamic range is used as the default bound when no override is given', async () => {
    const { useCase, subscriberRepo } = makeUseCase({
      subscribers: [makeSubscriber('001', undefined)],
      internetProfile: { dynamicRangeStart: '10.45.0.50', dynamicRangeEnd: '10.45.0.200' },
    });
    await useCase.execute();
    expect(subscriberRepo.assignIPv4ByApn).toHaveBeenCalledWith('001', 'internet', '10.45.0.50');
  });

  test('execute: an explicit override is clamped to stay inside the dynamic range (hard ceiling)', async () => {
    const { useCase, subscriberRepo } = makeUseCase({
      subscribers: [makeSubscriber('001', undefined)],
      internetProfile: { dynamicRangeStart: '10.45.0.50', dynamicRangeEnd: '10.45.0.200' },
    });
    // caller tries to reach into the static range (.2-.49) via an explicit override —
    // must not be honored once a dynamic range is defined.
    await useCase.execute({ startIp: '10.45.0.2', endIp: '10.45.0.254' });
    const assignedIp = subscriberRepo.assignIPv4ByApn.mock.calls[0][2];
    const num = assignedIp.split('.').map(Number).reduce((a: number, b: number) => a * 256 + b, 0);
    const lo = '10.45.0.50'.split('.').map(Number).reduce((a, b) => a * 256 + b, 0);
    const hi = '10.45.0.200'.split('.').map(Number).reduce((a, b) => a * 256 + b, 0);
    expect(num).toBeGreaterThanOrEqual(lo);
    expect(num).toBeLessThanOrEqual(hi);
  });
});
