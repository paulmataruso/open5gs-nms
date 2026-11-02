// Which address a TR-069 device is actually at, right now.
//
// GenieACS stores every parameter as a CACHED value plus the `_timestamp` of
// when it was last read, and the two IP sources age at completely different
// rates:
//
//   * `Device.ManagementServer.ConnectionRequestURL` is re-reported by the
//     device in EVERY Inform, so its timestamp tracks `_lastInform` and the
//     host inside it is always the device's current address.
//   * `Device.IP.Interface.1.IPv4Address.1.IPAddress` only changes when
//     something explicitly reads it — a getParameterValues from the Summon /
//     Refresh button, or a bootstrap walk. Nothing reads it on a periodic
//     inform, so after a radio changes address this value stays wrong until
//     an operator happens to refresh that device.
//
// Measured live on this deployment (2026-11-01, Sercomm 2112CW5000195):
// `Device.IP...IPAddress` read `10.0.2.151` with a timestamp 18 minutes old
// while `ConnectionRequestURL` read `172.16.0.31` with a timestamp equal to
// `_lastInform` — a different subnet entirely. A second Sercomm's cached
// Device.IP was FOUR DAYS old and only looked right because that radio had
// not moved. Preferring the cached value, as both the Baicells and Sercomm-4G
// paths used to, is therefore a staleness bug and not a preference.
//
// So: the freshest source wins, and the one that lost is reported rather than
// dropped, because "the page disagrees with GenieACS" is otherwise impossible
// to explain from the UI.

export type AcsIpSource = 'connection-request' | 'device-ip' | 'none';

export interface AcsIpResolution {
  /** The address to show. Empty when neither source holds a usable one. */
  ip: string;
  source: AcsIpSource;
  /**
   * Set only when the two sources genuinely disagree: the value that lost,
   * with how far behind its read was. Carries the explanation for a UI note.
   */
  staleAlternative?: { ip: string; source: AcsIpSource; ageSeconds: number };
}

export const ACS_DEVICE_IP_PARAM = 'Device.IP.Interface.1.IPv4Address.1.IPAddress';
export const ACS_CONNECTION_REQUEST_PARAM = 'Device.ManagementServer.ConnectionRequestURL';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4.exec(s ?? '');
  return !!m && m.slice(1).every(o => Number(o) <= 255 && !(o.length > 1 && o[0] === '0'));
}

/** The `{_value, _timestamp}` node at a dotted path, if there is one. */
function nodeAt(device: Record<string, any>, dotPath: string): any {
  let node: any = device;
  for (const part of dotPath.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

function valueAt(device: Record<string, any>, dotPath: string): { value: string; at: number } | null {
  const n = nodeAt(device, dotPath);
  if (n?._value == null) return null;
  const ts = Date.parse(String(n._timestamp ?? ''));
  return { value: String(n._value).trim(), at: Number.isFinite(ts) ? ts : 0 };
}

/**
 * The host part of a ConnectionRequestURL, when it is a literal IPv4 address.
 *
 * A URL carrying a hostname is a perfectly valid ConnectionRequestURL but is
 * not an answer to "what IP is this radio at", so it is not treated as one.
 */
export function connectionRequestHost(url: string): string {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^:/?#]+)/i.exec(url ?? '')?.[1] ?? '';
  return isIpv4(host) ? host : '';
}

export function resolveAcsDeviceIp(device: Record<string, any>): AcsIpResolution {
  const direct = valueAt(device, ACS_DEVICE_IP_PARAM);
  const cru = valueAt(device, ACS_CONNECTION_REQUEST_PARAM);

  const fromDirect = direct && isIpv4(direct.value) ? { ip: direct.value, at: direct.at } : null;
  const host = cru ? connectionRequestHost(cru.value) : '';
  const fromCru = host ? { ip: host, at: cru!.at } : null;

  if (!fromDirect && !fromCru) return { ip: '', source: 'none' };
  // ConnectionRequestURL is never staler than the cached interface address, so
  // it is the right answer whenever it is the only one, or they agree.
  if (!fromDirect) return { ip: fromCru!.ip, source: 'connection-request' };
  if (!fromCru) return { ip: fromDirect.ip, source: 'device-ip' };
  if (fromDirect.ip === fromCru.ip) return { ip: fromCru.ip, source: 'connection-request' };

  const cruWins = fromCru.at >= fromDirect.at;
  const winner = cruWins ? fromCru : fromDirect;
  const loser = cruWins ? fromDirect : fromCru;
  return {
    ip: winner.ip,
    source: cruWins ? 'connection-request' : 'device-ip',
    staleAlternative: {
      ip: loser.ip,
      source: cruWins ? 'device-ip' : 'connection-request',
      ageSeconds: Math.max(0, Math.round((winner.at - loser.at) / 1000)),
    },
  };
}
