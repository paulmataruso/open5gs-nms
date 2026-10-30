import pino from 'pino';

// "Bounce" shares one mechanism with Block and differs by a single CLR-Flags
// bit, so almost every rule worth having here is a rule about NOT reporting a
// success the network did not actually deliver. Those are invisible when
// wrong — the UI says "bounced", the handset just never comes back — so they
// are pinned rather than left to review.

const mockRunUeDetach = jest.fn();
const mockIsBuilt = jest.fn(() => true);
jest.mock('../ran/ue-detach-runner', () => ({
  runUeDetach: (...a: unknown[]) => mockRunUeDetach(...a),
  isUeDetachToolBuilt: () => mockIsBuilt(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UeDeregisterUseCase } = require('../ran/ue-deregister');

const IMSI = '001010000000007';
const logger = pino({ level: 'silent' });

function useCaseWith(ues5g: unknown[], ues4g: unknown[]) {
  const activeSessions = {
    getActive5GUEs: jest.fn().mockResolvedValue(ues5g),
    getActive4GUEs: jest.fn().mockResolvedValue(ues4g),
  };
  return {
    uc: new UeDeregisterUseCase(activeSessions, logger),
    activeSessions,
  };
}

const ue4g = (over: Record<string, unknown> = {}) => ({
  imsi: IMSI, ip: '10.45.0.7', sessions: [], cmState: 'connected', mmState: 'registered', ...over,
});

beforeEach(() => {
  mockRunUeDetach.mockReset();
  mockIsBuilt.mockReset().mockReturnValue(true);
});

describe('UeDeregisterUseCase — the re-attach bit', () => {
  it('asks for reattach, which is the whole point of the action', async () => {
    mockRunUeDetach.mockResolvedValue({ status: 'success', reattach: true });
    const { uc } = useCaseWith([], [ue4g()]);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('detached-sent');
    expect(r.reattachRequested).toBe(true);
    // An options object, never a positional boolean — a second positional arg
    // would land in the timeout slot and compute NaN.
    expect(mockRunUeDetach).toHaveBeenCalledWith(IMSI, expect.objectContaining({ reattach: true }));
    expect(typeof mockRunUeDetach.mock.calls[0][1].timeoutMs).toBe('number');
  });

  it('does NOT claim a bounce when the tool did not confirm the flag', async () => {
    // A deployed binary older than -reattach still answers success. Reporting
    // that as "bounced" is the stale-artifact trap this project keeps hitting:
    // the UE really is detached and really will not come back.
    mockRunUeDetach.mockResolvedValue({ status: 'success', reattach: false });
    const { uc } = useCaseWith([], [ue4g()]);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('detached-sent');
    expect(r.reattachRequested).toBe(false);
    expect(r.message).toMatch(/may NOT re-attach/i);
  });
});

describe('UeDeregisterUseCase — refusals that prevent a false success', () => {
  it('refuses a 4G UE the MME already considers de-registered', async () => {
    // The CLA carries DIAMETER_SUCCESS before the FSM check, so the MME would
    // drop the context and send no NAS Detach at all.
    const { uc } = useCaseWith([], [ue4g({ mmState: 'deregistered' })]);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('not-reachable-deregistered');
    expect(r.reattachRequested).toBe(false);
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });

  it('refuses an IDLE 5G UE instead of letting the AMF answer 204 silently', async () => {
    const { uc } = useCaseWith([{ imsi: IMSI, sessions: [], cmState: 'idle' }], []);
    const r = await uc.deregister(IMSI);

    expect(r.generation).toBe('5g');
    expect(r.status).toBe('not-reachable-idle');
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });

  it('never sends a 4G CLR for a UE that is on 5G', async () => {
    // Detecting the generation is what stops a 5G row producing a confusing
    // "not attached" from the MME.
    const { uc } = useCaseWith([{ imsi: IMSI, sessions: [], cmState: 'connected' }], [ue4g()]);
    const r = await uc.deregister(IMSI);

    expect(r.generation).toBe('5g');
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });

  it('reports an unbuilt tool as actionable, not as a generic failure', async () => {
    mockIsBuilt.mockReturnValue(false);
    const { uc } = useCaseWith([], [ue4g()]);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('unsupported');
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });
});

describe('UeDeregisterUseCase — outcome mapping', () => {
  it('maps Diameter 5001 USER_UNKNOWN to not-attached, not to rejected', async () => {
    mockRunUeDetach.mockResolvedValue({
      status: 'rejected', experimentalResultCode: 5001,
    });
    const { uc } = useCaseWith([], [ue4g()]);
    expect((await uc.deregister(IMSI)).status).toBe('not-attached');
  });

  it('keeps a genuine rejection distinct from "not attached"', async () => {
    mockRunUeDetach.mockResolvedValue({
      status: 'rejected', resultCode: 5012, message: 'DIAMETER_UNABLE_TO_COMPLY',
    });
    const { uc } = useCaseWith([], [ue4g()]);
    expect((await uc.deregister(IMSI)).status).toBe('rejected');
  });

  it('reports a timeout as a timeout, and does not retry', async () => {
    // Deliberately no retry: mme-s6a-handler.c wraps an SGs send in an
    // ogs_assert(), and an assert on an error return aborts the MME.
    mockRunUeDetach.mockResolvedValue({ status: 'timeout' });
    const { uc } = useCaseWith([], [ue4g()]);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('timeout');
    expect(mockRunUeDetach).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown IMSI as information, not an exception', async () => {
    const { uc } = useCaseWith([], []);
    const r = await uc.deregister(IMSI);
    expect(r.status).toBe('not-attached');
    expect(r.generation).toBe('unknown');
  });

  it('ignores metricsOnly rows, which carry no usable IMSI', async () => {
    const { uc } = useCaseWith([], [ue4g({ imsi: '', metricsOnly: true })]);
    expect((await uc.deregister(IMSI)).status).toBe('not-attached');
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });

  it('surfaces a lookup failure as its own state rather than "not attached"', async () => {
    const activeSessions = {
      getActive5GUEs: jest.fn().mockRejectedValue(new Error('MME unreachable')),
      getActive4GUEs: jest.fn().mockResolvedValue([]),
    };
    const uc = new UeDeregisterUseCase(activeSessions, logger);
    const r = await uc.deregister(IMSI);

    expect(r.status).toBe('lookup-failed');
    expect(mockRunUeDetach).not.toHaveBeenCalled();
  });
});
