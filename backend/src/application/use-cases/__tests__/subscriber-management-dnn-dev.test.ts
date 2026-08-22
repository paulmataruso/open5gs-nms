// Regression coverage for GitHub issue #28: "Apply static route on host" installed
// the route on the wrong `dev` when DNN interfaces are custom-named, because
// resolveDnnDevMap() read `dnn` off upf.yaml's session list — a field Open5GS's real
// UPF schema doesn't define at all (only this project's UpfEditor writes it, as a
// convenience annotation).
import { SubscriberManagementUseCase } from '../subscriber-management';

function makeUseCase(configRepo: any, warn: jest.Mock = jest.fn()) {
  const logger = { info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() } as any;
  return new SubscriberManagementUseCase(
    {} as any, // subscriberRepo — unused by resolveDnnDevMap
    {} as any, // auditLogger
    logger,
    {} as any, // tunUseCase
    configRepo,
    {} as any, // db
  );
}

async function resolve(uc: SubscriberManagementUseCase): Promise<Map<string, string>> {
  return (uc as any).resolveDnnDevMap();
}

describe('SubscriberManagementUseCase.resolveDnnDevMap', () => {
  test('matches by upf.yaml\'s own dnn field when present (the common, NMS-managed case)', async () => {
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({ session: [{ dnn: 'internet', subnet: '10.45.0.0/16' }] }),
      loadUpf: jest.fn().mockResolvedValue({ session: [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }] }),
    };
    const map = await resolve(makeUseCase(configRepo));
    expect(map.get('internet')).toBe('ogstun');
  });

  test('falls back to exact subnet match when upf.yaml has no dnn field (reported bug repro)', async () => {
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({ session: [{ dnn: 'video.example.com', subnet: '203.0.113.0/24' }] }),
      loadUpf: jest.fn().mockResolvedValue({ session: [{ subnet: '203.0.113.0/24', dev: 'video' }] }), // no dnn key at all
    };
    const map = await resolve(makeUseCase(configRepo));
    expect(map.get('video.example.com')).toBe('video');
  });

  test('falls back to IPv4 CIDR overlap when SMF/UPF declare different prefix lengths for the same DNN', async () => {
    // Confirmed on a real deployment: SMF's "internet" pool is 10.45.0.0/16 while
    // UPF's own session for the same DNN is a narrower 10.45.0.0/24 — an exact
    // subnet-string join alone would miss this.
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({ session: [{ dnn: 'internet', subnet: '10.45.0.0/16' }] }),
      loadUpf: jest.fn().mockResolvedValue({ session: [{ subnet: '10.45.0.0/24', dev: 'ogstun' }] }), // no dnn, narrower prefix
    };
    const map = await resolve(makeUseCase(configRepo));
    expect(map.get('internet')).toBe('ogstun');
  });

  test('warns and omits the DNN when no UPF session matches by dnn or subnet', async () => {
    const warn = jest.fn();
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({ session: [{ dnn: 'orphan', subnet: '192.0.2.0/24' }] }),
      loadUpf: jest.fn().mockResolvedValue({ session: [{ dnn: 'internet', subnet: '10.45.0.0/24', dev: 'ogstun' }] }),
    };
    const map = await resolve(makeUseCase(configRepo, warn));
    expect(map.has('orphan')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  test('multiple DNNs on separate custom-named TUN devices resolve independently (issue #28\'s exact scenario)', async () => {
    const configRepo = {
      loadSmf: jest.fn().mockResolvedValue({
        session: [
          { dnn: 'internet', subnet: '10.45.0.0/16', gateway: '10.45.0.1' },
          { dnn: 'ptt.example.com', subnet: '198.51.100.0/24', gateway: '198.51.100.1' },
          { dnn: 'video.example.com', subnet: '203.0.113.0/24', gateway: '203.0.113.1' },
          { dnn: 'surveillance.example.net', subnet: '192.0.2.0/24', gateway: '192.0.2.1' },
        ],
      }),
      loadUpf: jest.fn().mockResolvedValue({
        session: [
          { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun' },
          { subnet: '198.51.100.0/24', gateway: '198.51.100.1', dev: 'ptt' },
          { subnet: '203.0.113.0/24', gateway: '203.0.113.1', dev: 'video' },
          { subnet: '192.0.2.0/24', gateway: '192.0.2.1', dev: 'surveillance' },
        ],
      }),
    };
    const map = await resolve(makeUseCase(configRepo));
    expect(map.get('internet')).toBe('ogstun');
    expect(map.get('ptt.example.com')).toBe('ptt');
    expect(map.get('video.example.com')).toBe('video');
    expect(map.get('surveillance.example.net')).toBe('surveillance');
  });
});
