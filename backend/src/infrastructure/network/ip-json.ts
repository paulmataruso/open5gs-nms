// Reading iproute2's JSON output (`ip -j ...`).
//
// Sibling of ip-link-parser.ts, which does the same job for the older
// `ip -o` TEXT format. This one exists because `main-interface.ts` and
// `secondary-address.ts` each walked the same `ip -j addr show` document by
// hand, both typed `any[]` with `(a: any) =>` callbacks — which switched off
// type checking for every read beneath them. Extracted during CI-LINT-PLAN
// Phase 6.
//
// The shapes below were checked against this host's real output rather than
// read off the man page: 19 interfaces, every `ifname` a string, every `inet`
// addr_info carrying a string `local` and a numeric `prefixlen`. Only the
// fields something here actually reads are named; the index signature keeps
// the rest (`mtu`, `qdisc`, `altnames`, `xdp`, …) reachable without
// pretending to model them.

/** One entry of an interface's `addr_info` array. */
export interface IpAddrInfo {
  family?: unknown;
  local?: unknown;
  prefixlen?: unknown;
  [key: string]: unknown;
}

/** One interface, as `ip -j addr show` reports it. */
export interface IpAddrEntry {
  ifname?: unknown;
  address?: unknown;
  operstate?: unknown;
  addr_info?: unknown;
  [key: string]: unknown;
}

import { isIpv4 } from '../../domain/services/ip-utils';

/** A well-formed IPv4 assignment: the two fields every caller needs. */
export interface Ipv4Assignment {
  ip: string;
  prefix: number;
}

/**
 * `ip -j addr show` as a list of interfaces, or an empty list.
 *
 * Returns [] rather than throwing for output that is not a JSON array —
 * empty stdout, or a tool that wrote a message instead. An interface whose
 * `ifname` is not a string is DROPPED: the old hand-rolled filters tested
 * `!i.ifname?.startsWith('lo')`, which is `true` when `ifname` is absent, so
 * such an entry was kept and then produced `name: undefined` through a field
 * declared `string`.
 */
export function parseIpAddrShow(stdout: string): IpAddrEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is IpAddrEntry =>
    typeof e === 'object' && e !== null && typeof (e as IpAddrEntry).ifname === 'string');
}

/** An interface's name. Safe because parseIpAddrShow dropped the nameless. */
export function ifaceName(entry: IpAddrEntry): string {
  return typeof entry.ifname === 'string' ? entry.ifname : '';
}

/** An interface's MAC, or null when it has none (a TUN device, for example). */
export function ifaceMac(entry: IpAddrEntry): string | null {
  return typeof entry.address === 'string' ? entry.address : null;
}

/** An interface's operational state, or null when it is not reported. */
export function ifaceState(entry: IpAddrEntry): string | null {
  return typeof entry.operstate === 'string' ? entry.operstate : null;
}

/**
 * An interface's IPv4 assignments.
 *
 * An entry is kept only when it is genuinely usable — `family` exactly
 * `'inet'`, a string `local`, and an integer `prefixlen` in 0–32. This is the
 * boundary where the kernel's output stops being untrusted, so every caller
 * downstream gets addresses it can do arithmetic on. The previous copies
 * asserted instead (`.map((a: any) => a.local as string)`, and a
 * `${a.local}/${a.prefixlen}` template), which turned a missing field into the
 * strings `"undefined"` and `"undefined/NaN"` inside a `string[]`.
 */
export function ipv4AssignmentsOf(entry: IpAddrEntry): Ipv4Assignment[] {
  const info = entry.addr_info;
  if (!Array.isArray(info)) return [];
  const out: Ipv4Assignment[] = [];
  for (const raw of info) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as IpAddrInfo;
    if (a.family !== 'inet') continue;
    // A real dotted quad, not merely a string. ip-utils' own validator, so
    // "a valid IPv4 address" has one definition in this codebase. Without
    // this, a truncated "10.0.2" is still a string and reaches the CIDR
    // arithmetic downstream, which is precisely the defect this slice fixes.
    if (typeof a.local !== 'string' || !isIpv4(a.local)) continue;
    if (typeof a.prefixlen !== 'number' || !Number.isInteger(a.prefixlen)) continue;
    if (a.prefixlen < 0 || a.prefixlen > 32) continue;
    out.push({ ip: a.local, prefix: a.prefixlen });
  }
  return out;
}

/**
 * The interface named by the first route in `ip -j route show default`.
 *
 * Null when there is no default route, or its entry carries no `dev` — which
 * is the honest answer for a host with no upstream, and what the callers'
 * "no interface owns the default route" branches already expect.
 */
export function defaultRouteDevice(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const dev = (raw as Record<string, unknown>).dev;
    if (typeof dev === 'string' && dev !== '') return dev;
  }
  return null;
}
