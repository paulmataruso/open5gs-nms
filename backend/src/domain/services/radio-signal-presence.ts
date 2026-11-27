interface UePresence {
  cmState?: string; mmState?: string; sampledAt?: number | null;
}
interface RadioPresence {
  enabled: boolean; lastError?: string | null; lastPolledAt?: number | null; ueCount?: number | null;
}

export function isOnlineSignalUe(ue: UePresence, radio?: RadioPresence, now = Date.now()): boolean {
  if (ue.cmState === 'connected' && ue.mmState !== 'deregistered') return true;
  if (!radio?.enabled || radio.lastError || radio.ueCount === 0 || !radio.lastPolledAt || !ue.sampledAt) return false;
  return now - radio.lastPolledAt < 45000 && radio.lastPolledAt <= now + 1000
    && ue.sampledAt >= radio.lastPolledAt - 1000 && ue.sampledAt <= now + 1000;
}
