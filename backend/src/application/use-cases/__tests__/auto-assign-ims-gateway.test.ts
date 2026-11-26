import { AutoAssignIPsUseCase } from '../auto-assign-ips-usecase';

/**
 * The IMS allocator must skip the IMS gateway, exactly as the internet
 * allocator skips its own.
 *
 * The internet loop has always had the guard:
 *
 *   if ((gatewayIPNum !== null && cursor === gatewayIPNum) || occupied.has(cursor))
 *
 * The IMS loop ~70 lines below checked only `imsOccupied`. parseSubnet() starts
 * a pool at network+1, which for this host's live 10.46.0.0/24 IMS pool is
 * 10.46.0.1 -- the gateway itself. execute() never even loaded the IMS gateway,
 * which is why it could not exclude it, although getPoolInfo() was already
 * reading it for display.
 *
 * The only thing preventing a UE being handed the gateway was the dynamic-range
 * clamp happening to start at .2, which requires an APN profile with a range
 * set. That is an accident of configuration, not a guarantee.
 */
interface Assigned { imsi: string; apn: string; ip: string }

function makeUseCase(assigned: Assigned[], subscribers: unknown[]): AutoAssignIPsUseCase {
  const subscriberRepo = {
    findAll: () => Promise.resolve(subscribers),
    findAllFull: () => Promise.resolve(subscribers),
    assignIPv4ByApn: (imsi: string, apn: string, ip: string): Promise<void> => {
      assigned.push({ imsi, apn, ip }); return Promise.resolve();
    },
    getAllFramedRoutes: () => Promise.resolve([]),
  };
  const configRepo = {
    loadUpf: () => Promise.resolve({ rawYaml: { upf: { session: [
      { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun', dnn: 'internet' },
      { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dev: 'ogstun2', dnn: 'ims' },
    ] } } }),
    loadSmf: () => Promise.resolve({ rawYaml: { smf: { session: [
      { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dnn: 'internet' },
      { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims' },
    ] } } }),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  // No apnProfileRepo: that is the case with no dynamic range, which is
  // exactly when the missing gateway guard bites.
  return new AutoAssignIPsUseCase(subscriberRepo as never, configRepo as never, logger as never);
}

const subscriber = (imsi: string): Record<string, unknown> => ({
  imsi,
  slice: [{ sst: 1, session: [
    { name: 'internet', ue: {} },
    { name: 'ims', ue: {} },
  ] }],
});

describe('IMS allocation skips the gateway', () => {
  it('never hands a UE the IMS gateway address', async () => {
    const assigned: Assigned[] = [];
    const uc = makeUseCase(assigned, [subscriber('001010000000001')]);
    await uc.execute({ imsStartIp: '10.46.0.1', imsEndIp: '10.46.0.10', imsOverwrite: true });

    const ims = assigned.filter(a => a.apn === 'ims');
    expect(ims).toHaveLength(1);
    expect(ims[0].ip).not.toBe('10.46.0.1'); // the gateway
    expect(ims[0].ip).toBe('10.46.0.2');
  });

  it('still skips the internet gateway, which always worked', async () => {
    const assigned: Assigned[] = [];
    const uc = makeUseCase(assigned, [subscriber('001010000000001')]);
    await uc.execute({ startIp: '10.45.0.1', endIp: '10.45.0.10', overwrite: true });

    const inet = assigned.filter(a => a.apn === 'internet');
    expect(inet[0].ip).not.toBe('10.45.0.1');
    expect(inet[0].ip).toBe('10.45.0.2');
  });

  it('allocates consecutive IMS addresses after the gateway', async () => {
    const assigned: Assigned[] = [];
    const uc = makeUseCase(assigned, [
      subscriber('001010000000001'), subscriber('001010000000002'), subscriber('001010000000003'),
    ]);
    await uc.execute({ imsStartIp: '10.46.0.1', imsEndIp: '10.46.0.10', imsOverwrite: true });
    expect(assigned.filter(a => a.apn === 'ims').map(a => a.ip))
      .toEqual(['10.46.0.2', '10.46.0.3', '10.46.0.4']);
  });
});

describe('IP parsing rejects malformed input instead of inventing an address', () => {
  const toNum = (uc: AutoAssignIPsUseCase, ip: string): number =>
    (uc as unknown as { ipToNumber(s: string): number }).ipToNumber(ip);

  it('throws on a three-octet address rather than returning 10.45.0.0', () => {
    // The old local helper silently produced 10.45.0.0 for both of these --
    // a plausible-looking WRONG address.
    const uc = makeUseCase([], []);
    expect(() => toNum(uc, '10.45.0')).toThrow(/Invalid IPv4/);
    expect(() => toNum(uc, '10.45.0.x')).toThrow(/Invalid IPv4/);
  });

  it('throws on an empty string rather than returning 0.0.0.0', () => {
    expect(() => toNum(makeUseCase([], []), '')).toThrow(/Invalid IPv4/);
  });

  it('still parses a valid address', () => {
    expect(toNum(makeUseCase([], []), '10.46.0.1')).toBe(170786817);
  });
});
