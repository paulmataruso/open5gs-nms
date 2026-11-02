// How a DHCP subnet is reached — the presentation half of the rule that a
// subnet is INDEPENDENT of which interfaces Kea listens on.
//
// Kea's own documented behaviour, which is what this reports:
//
//   * A directly connected client is answered from the subnet that contains
//     the server's own address on the interface the request arrived on.
//   * "If the message is relayed it is accepted through any interface. The
//     giaddr set by the relay agent is used to select the subnet for the
//     client."
//
// So a subnet with no local interface in its range is not a mistake — it is an
// ordinary remote segment behind a relay, and the badge says so rather than
// warning about it.
//
// Pure on purpose: no React, no browser APIs, so the backend's jest run can
// execute this module directly (same arrangement as ran/radio-grouping.ts).

/** The only interface fields this module needs. */
export interface ReachIface {
  name: string;
  /** Primary IPv4 CIDR, or null when the interface has no IPv4 address. */
  cidr: string | null;
  blocked: boolean;
}

export type ReachKind = 'direct' | 'relayed' | 'unknown';

export interface SubnetReach {
  /**
   * `direct` — at least one usable local interface holds an address in range.
   * `relayed` — none does, so requests can only arrive through a relay.
   * `unknown` — the CIDR is not (yet) well formed, e.g. mid-typing.
   */
  kind: ReachKind;
  /** Usable local interfaces whose own address falls inside the subnet. */
  ifaces: string[];
}

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;

/** Dotted quad to a number, or null when it is not a valid IPv4 address. */
export function ipv4ToNum(ip: string): number | null {
  const parts = (ip ?? '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    // `>>> 0` after every shift: JS bitwise operators work on SIGNED Int32, so
    // anything with a first octet >= 128 otherwise comes back negative. This is
    // the exact footgun CLAUDE.md records against ip-utils.ts's cidrRange.
    n = ((n << 8) >>> 0) + o;
  }
  return n >>> 0;
}

/** Inclusive numeric range a CIDR covers, network and broadcast included. */
export function cidrNumRange(cidr: string): { first: number; last: number } | null {
  const m = CIDR_RE.exec((cidr ?? '').trim());
  if (!m) return null;
  const base = ipv4ToNum(m[1]);
  const prefix = Number(m[2]);
  if (base === null || prefix < 0 || prefix > 32) return null;
  const size = prefix === 0 ? 0x100000000 : 2 ** (32 - prefix);
  const first = (base & (prefix === 0 ? 0 : (-1 << (32 - prefix)))) >>> 0;
  return { first, last: first + size - 1 };
}

export function cidrContainsIp(cidr: string, ip: string): boolean {
  const r = cidrNumRange(cidr);
  const n = ipv4ToNum(ip);
  if (!r || n === null) return false;
  return n >= r.first && n <= r.last;
}

/** Classifies one subnet against the host's real interface list. */
export function subnetReach(subnetCidr: string, interfaces: ReachIface[]): SubnetReach {
  if (!cidrNumRange(subnetCidr)) return { kind: 'unknown', ifaces: [] };
  const ifaces = interfaces
    .filter(i => !i.blocked && !!i.cidr && cidrContainsIp(subnetCidr, i.cidr.split('/')[0]))
    .map(i => i.name);
  return { kind: ifaces.length > 0 ? 'direct' : 'relayed', ifaces };
}

/**
 * True when some configured subnet leases out of this interface's OWN range —
 * the only situation in which an interface's `localPoolWarnings` mean anything.
 */
export function ifaceServesOwnRange(iface: ReachIface, subnetCidrs: string[]): boolean {
  if (!iface.cidr) return false;
  const addr = iface.cidr.split('/')[0];
  return subnetCidrs.some(c => cidrContainsIp(c, addr));
}
