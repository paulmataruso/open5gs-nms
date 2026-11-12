import { isOnlineSignalUe } from '../radio-signal-presence';

describe('online UE signal overview', () => {
  const now = 100000;
  const radio = { enabled: true, lastPolledAt: now, ueCount: 1 };
  it('excludes provisioned-only subscribers and idle/deregistered core contexts', () => {
    expect(isOnlineSignalUe({}, undefined, now)).toBe(false);
    expect(isOnlineSignalUe({ cmState: 'idle', mmState: 'registered' }, undefined, now)).toBe(false);
    expect(isOnlineSignalUe({ cmState: 'connected', mmState: 'deregistered' }, undefined, now)).toBe(false);
    expect(isOnlineSignalUe({ cmState: 'connected', mmState: 'registered' }, undefined, now)).toBe(true);
  });
  it('keeps only a fresh observation from the latest successful radio poll', () => {
    expect(isOnlineSignalUe({ sampledAt: now - 5 }, radio, now)).toBe(true);
    expect(isOnlineSignalUe({ sampledAt: now - 15000 }, radio, now)).toBe(false);
    expect(isOnlineSignalUe({ sampledAt: now }, { ...radio, ueCount: 0 }, now)).toBe(false);
    expect(isOnlineSignalUe({ sampledAt: now }, { ...radio, lastError: 'timeout' }, now)).toBe(false);
    expect(isOnlineSignalUe({ sampledAt: now }, { ...radio, enabled: false }, now)).toBe(false);
    expect(isOnlineSignalUe({ sampledAt: now }, radio, now + 45001)).toBe(false);
    expect(isOnlineSignalUe({ sampledAt: now + 5000 }, radio, now)).toBe(false);
  });
});
