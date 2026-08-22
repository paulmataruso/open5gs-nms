// Regression coverage for the sibling of issue #28 found while fixing it:
// AutoAssignIPsUseCase.getPoolInfo()'s IMS session lookup relied on upf.yaml's own
// (non-standard, NMS-written-only) `dnn` field with no fallback, unlike the
// "internet" pool lookup two lines above it — a upf.yaml missing `dnn` on the IMS
// session silently reported "no IMS session configured" even when one exists.
import { AutoAssignIPsUseCase } from '../auto-assign-ips-usecase';

const IMS_SUBSCRIBER = {
  imsi: '001010000000099',
  slice: [{ session: [{ name: 'ims', ue: { ipv4: '10.46.0.5' } }] }],
};

function makeUseCase(configRepo: any, subscribers: any[] = []) {
  const subscriberRepo = { findAllFull: jest.fn().mockResolvedValue(subscribers) } as any;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  return new AutoAssignIPsUseCase(subscriberRepo, configRepo, logger);
}

describe('AutoAssignIPsUseCase.getPoolInfo — IMS session resolution', () => {
  test('matches by upf.yaml\'s own dnn=ims field when present (the common, NMS-managed case)', async () => {
    const configRepo = {
      loadUpf: jest.fn().mockResolvedValue({ rawYaml: { upf: { session: [
        { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dnn: 'internet' },
        { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dev: 'ogstun2' },
      ] } } }),
      loadSmf: jest.fn().mockResolvedValue({ rawYaml: { smf: { session: [] } } }),
    };
    const info = await makeUseCase(configRepo, [IMS_SUBSCRIBER]).getPoolInfo();
    expect(info.imsApn).toBe('ims');
    expect(info.imsPool).toBe('10.46.0.0/24');
    expect(info.imsGatewayIp).toBe('10.46.0.1');
  });

  test('falls back to an exact subnet join against smf.yaml when upf.yaml has no dnn field', async () => {
    const configRepo = {
      loadUpf: jest.fn().mockResolvedValue({ rawYaml: { upf: { session: [
        { subnet: '10.45.0.0/24', gateway: '10.45.0.1' },
        { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dev: 'ogstun2' }, // no dnn key at all
      ] } } }),
      loadSmf: jest.fn().mockResolvedValue({ rawYaml: { smf: { session: [
        { subnet: '10.45.0.0/24', dnn: 'internet' },
        { subnet: '10.46.0.0/24', dnn: 'ims' },
      ] } } }),
    };
    const info = await makeUseCase(configRepo, [IMS_SUBSCRIBER]).getPoolInfo();
    expect(info.imsPool).toBe('10.46.0.0/24');
    expect(info.imsGatewayIp).toBe('10.46.0.1');
  });

  test('falls back to IPv4 CIDR overlap when SMF/UPF declare different prefix lengths for the IMS DNN', async () => {
    const configRepo = {
      loadUpf: jest.fn().mockResolvedValue({ rawYaml: { upf: { session: [
        { subnet: '10.45.0.0/24', gateway: '10.45.0.1' },
        { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dev: 'ogstun2' }, // no dnn key
      ] } } }),
      loadSmf: jest.fn().mockResolvedValue({ rawYaml: { smf: { session: [
        { subnet: '10.45.0.0/24', dnn: 'internet' },
        { subnet: '10.46.0.0/16', dnn: 'ims' }, // wider prefix than UPF's own session
      ] } } }),
    };
    const info = await makeUseCase(configRepo, [IMS_SUBSCRIBER]).getPoolInfo();
    // The UPF session's own (narrower, functionally correct) subnet is what's reported.
    expect(info.imsPool).toBe('10.46.0.0/24');
  });

  test('no IMS DNN anywhere leaves ims* fields undefined without throwing', async () => {
    const configRepo = {
      loadUpf: jest.fn().mockResolvedValue({ rawYaml: { upf: { session: [
        { subnet: '10.45.0.0/24', gateway: '10.45.0.1' },
      ] } } }),
      loadSmf: jest.fn().mockResolvedValue({ rawYaml: { smf: { session: [
        { subnet: '10.45.0.0/24', dnn: 'internet' },
      ] } } }),
    };
    const info = await makeUseCase(configRepo, []).getPoolInfo();
    expect(info.imsApn).toBeUndefined();
    expect(info.imsPool).toBeUndefined();
  });
});
