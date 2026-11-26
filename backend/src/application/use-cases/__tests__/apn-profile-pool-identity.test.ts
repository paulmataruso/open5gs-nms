import { ApnProfileUseCase } from '../apn-profile-usecase';
import type { ApnProfile } from '../../../domain/entities/apn-profile';

/**
 * A session pool belongs to a profile by its DNN, never by its `dev`.
 *
 * Both halves of this file used to key the UPF pool on `dev`, which is a
 * SHARED interface rather than a per-APN identity:
 *
 *   patchYamlConfigs:  findIndex(s => (s.dev || 'ogstun') === profile.dev)
 *   removeYamlConfigs: filter(s => (s.dev || 'ogstun') !== profile.dev && ...)
 *
 * `dev` defaults to `ogstun`, which is also what this deployment's primary
 * `internet` pool uses. So creating any further profile on the default dev
 * matched the internet pool FIRST and overwrote it with the new profile's
 * subnet and dnn -- taking out the main UE address pool -- and deleting such a
 * profile removed every other pool on that interface, because the filter's two
 * keep-conditions are ANDed and therefore remove on EITHER match.
 *
 * The fixtures below are this host's real layout: internet v4+v6 on ogstun,
 * ims on ogstun2.
 */
type Session = Record<string, unknown>;

function liveUpfPools(): Session[] {
  return [
    { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun', dnn: 'internet' },
    { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1', dev: 'ogstun', dnn: 'internet' },
    { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dev: 'ogstun2' },
  ];
}
function liveSmfPools(): Session[] {
  return [
    { subnet: '10.45.0.0/24', gateway: '10.45.0.1', dnn: 'internet' },
    { subnet: '2001:db8:cafe::/48', gateway: '2001:db8:cafe::1', dnn: 'internet' },
    { subnet: '10.46.0.0/24', gateway: '10.46.0.1', dnn: 'ims', dns: ['10.0.1.178'] },
  ];
}

/**
 * Captures what is SAVED, not the array passed in: removeYamlConfigs uses
 * `filter`, which produces a new array, so asserting on the input reference
 * would miss the removal entirely.
 */
interface Saved { smf: Session[] | undefined; upf: Session[] | undefined }

function makeUseCase(smfPools: Session[], upfPools: Session[]): { uc: ApnProfileUseCase; saved: Saved } {
  const saved: Saved = { smf: undefined, upf: undefined };
  const smfDoc = { smf: { session: smfPools } };
  const upfDoc = { upf: { session: upfPools } };
  const configRepo = {
    loadSmf: () => Promise.resolve({ rawYaml: smfDoc }),
    loadUpf: () => Promise.resolve({ rawYaml: upfDoc }),
    saveSmf: (c: { rawYaml?: { smf?: { session?: Session[] } } }): Promise<void> => {
      saved.smf = c.rawYaml?.smf?.session; return Promise.resolve();
    },
    saveUpf: (c: { rawYaml?: { upf?: { session?: Session[] } } }): Promise<void> => {
      saved.upf = c.rawYaml?.upf?.session; return Promise.resolve();
    },
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { uc: new ApnProfileUseCase({} as never, configRepo as never, logger as never), saved };
}

const profile = (over: Partial<ApnProfile>): ApnProfile => ({
  id: 'p1', dnn: 'mms', dev: 'ogstun', subnet: '10.47.0.0/24', gateway: '10.47.0.1',
  qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
  staticRangeStart: null, staticRangeEnd: null, dynamicRangeStart: null, dynamicRangeEnd: null,
  createdAt: '', updatedAt: '', ...over,
} as ApnProfile);

const patch = (uc: ApnProfileUseCase, p: ApnProfile): Promise<void> =>
  (uc as unknown as { patchYamlConfigs(x: ApnProfile): Promise<void> }).patchYamlConfigs(p);
const remove = (uc: ApnProfileUseCase, p: ApnProfile): Promise<void> =>
  (uc as unknown as { removeYamlConfigs(x: ApnProfile): Promise<void> }).removeYamlConfigs(p);

describe('a new profile on the default dev must not touch the internet pool', () => {
  it('appends its own pool instead of overwriting internet', async () => {
    const { uc, saved } = makeUseCase(liveSmfPools(), liveUpfPools());
    await patch(uc, profile({ dnn: 'mms', dev: 'ogstun' }));

    // The internet v4 pool must be exactly as it was.
    expect(saved.upf![0]).toEqual({ subnet: '10.45.0.0/24', gateway: '10.45.0.1', dev: 'ogstun', dnn: 'internet' });
    expect(saved.upf!.find(s => s.dnn === 'mms'))
      .toEqual({ subnet: '10.47.0.0/24', gateway: '10.47.0.1', dev: 'ogstun', dnn: 'mms' });
    expect(saved.upf).toHaveLength(4);
  });

  it('updates its OWN pool in place on a second save', async () => {
    const upf = [...liveUpfPools(), { subnet: '10.47.0.0/24', dev: 'ogstun', dnn: 'mms' }];
    const { uc, saved } = makeUseCase(liveSmfPools(), upf);
    await patch(uc, profile({ dnn: 'mms', dev: 'ogstun', subnet: '10.48.0.0/24', gateway: '10.48.0.1' }));
    expect(saved.upf).toHaveLength(4);
    expect(saved.upf!.find(s => s.dnn === 'mms')).toMatchObject({ subnet: '10.48.0.0/24' });
    expect(saved.upf![0]).toMatchObject({ dnn: 'internet', subnet: '10.45.0.0/24' });
  });

  it('preserves an unmodelled key on its own pool', async () => {
    const { uc, saved } = makeUseCase(liveSmfPools(), liveUpfPools());
    await patch(uc, profile({ dnn: 'ims', dev: 'ogstun2', subnet: '10.46.0.0/24', gateway: '10.46.0.1' }));
    expect(saved.smf!.find(s => s.dnn === 'ims')).toMatchObject({ dns: ['10.0.1.178'] });
  });
});

describe('deleting a profile removes only its own pools', () => {
  it('leaves other pools on the same dev alone', async () => {
    const upf = [...liveUpfPools(), { subnet: '10.47.0.0/24', dev: 'ogstun', dnn: 'mms' }];
    const smf = [...liveSmfPools(), { subnet: '10.47.0.0/24', dnn: 'mms' }];
    const { uc, saved } = makeUseCase(smf, upf);
    await remove(uc, profile({ dnn: 'mms', dev: 'ogstun', subnet: '10.47.0.0/24' }));
    // internet (SAME dev) and ims must both survive.
    expect(saved.upf!.map(s => s.dnn)).toEqual(['internet', 'internet', 'ims']);
    expect(saved.smf!.map(s => s.dnn)).toEqual(['internet', 'internet', 'ims']);
  });

  it('removes BOTH address families of its own pool', async () => {
    const { uc, saved } = makeUseCase(liveSmfPools(), liveUpfPools());
    await remove(uc, profile({ dnn: 'internet', dev: 'ogstun', subnet: '10.45.0.0/24' }));
    expect(saved.upf!.map(s => s.dnn)).toEqual(['ims']);
  });

  it('matches a legacy entry with no dnn by its subnet', async () => {
    // upf.yaml sessions often carry no dnn -- Open5GS's UPF schema has no such
    // field; only this project's editor writes it.
    const upf: Session[] = [
      { subnet: '10.45.0.0/24', dev: 'ogstun' },
      { subnet: '10.47.0.0/24', dev: 'ogstun' },
    ];
    const { uc, saved } = makeUseCase([], upf);
    await remove(uc, profile({ dnn: 'mms', dev: 'ogstun', subnet: '10.47.0.0/24' }));
    expect(saved.upf).toEqual([{ subnet: '10.45.0.0/24', dev: 'ogstun' }]);
  });

  it('does not remove a legacy entry belonging to a different subnet', async () => {
    const upf: Session[] = [{ subnet: '10.45.0.0/24', dev: 'ogstun' }];
    const { uc, saved } = makeUseCase([], upf);
    await remove(uc, profile({ dnn: 'mms', dev: 'ogstun', subnet: '10.47.0.0/24' }));
    // Nothing matched, so nothing was saved at all.
    expect(saved.upf).toBeUndefined();
  });
});
