// ── UE pool reachability: routed vs host-NAT ────────────────────────────────
//
// A UE pool needs exactly one return path, and there are only two:
//
//   routed   the pool is a `network` statement in the live routing process, so
//            the upstream router learns it and sends replies back to this host
//   host-NAT the pool is MASQUERADEd to this host's egress address, so no
//            upstream route is needed at all
//
// They are mutually exclusive, and having NEITHER is a silent outage: UEs stay
// attached, get an address, and send traffic that never comes back. That is the
// state the UE-subnet rollback used to leave behind, because it could only
// restore MASQUERADE rules it had previously removed — on a deployment where
// NAT was never configured in the first place there was nothing stored, so it
// withdrew the routes and added nothing.
//
// ── Why this parses the LIVE config instead of reading stored state ─────────
//
// frr-migration-state.json records the protocol that the migration wizard last
// configured. It goes stale the moment anything is changed outside the wizard,
// and on this deployment it IS stale: it says `"protocol": "eigrp"` while the
// host has been running OSPF since the 2026-11-04 migration, which was applied
// by hand. Generating a config from that state writes an EIGRP stanza over a
// working OSPF one — so the protocol has to come from FRR itself.
//
// This also keeps the change incremental. Rewriting frr.conf wholesale and
// reloading is how this project triggered frr#943 twice live (2026-08-26); the
// documented-safe method for a prefix change is a `vtysh` edit against the
// already-established adjacency, which never tears it down. A `network`
// statement is exactly that kind of change.

export type RoutingProtocol = 'ospf' | 'eigrp' | 'bgp';

export interface LiveRoutingProcess {
  protocol: RoutingProtocol;
  /**
   * The real `router ...` line, reused verbatim. For EIGRP and BGP it carries
   * the AS number, which we must not guess — re-entering `router bgp 1` when
   * the live process is `router bgp 65001` creates a second, broken instance.
   */
  routerLine: string;
  /** OSPF only: the area its `network` statements are bound to. */
  area?: string;
}

/**
 * Discover the routing process from `vtysh -c "show running-config"`.
 * Returns null when no routing process is configured, in which case there is
 * nothing to withdraw and the caller should not invent one.
 */
export function parseLiveRoutingProcess(runningConfig: string): LiveRoutingProcess | null {
  const lines = (runningConfig ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Anchored: a `network`/`redistribute` line mentioning the word "router",
    // or a comment, must not be mistaken for the stanza header.
    const m = /^router\s+(ospf|eigrp|bgp)\b(.*)$/.exec(lines[i].trim());
    if (!m) continue;

    const protocol = m[1] as RoutingProtocol;
    const routerLine = lines[i].trim();

    if (protocol !== 'ospf') return { protocol, routerLine };

    // OSPF binds every `network` to an area, and `no network X` is rejected
    // unless the area matches the one it was added with. Read it off an
    // existing statement rather than assuming 0 — a non-backbone area is legal
    // and would make every withdrawal silently fail.
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].trim();
      if (/^(router|exit|end)\b/.test(body) && j > i + 1) break;
      const area = /^network\s+\S+\s+area\s+(\S+)$/.exec(body);
      if (area) return { protocol, routerLine, area: area[1] };
    }
    return { protocol, routerLine, area: '0' };
  }

  return null;
}

/**
 * `vtysh -c` arguments that add or withdraw UE pool `network` statements in the
 * live process, leaving everything else in the config untouched.
 */
export function ueNetworkStatementCommands(
  proc: LiveRoutingProcess,
  subnets: string[],
  op: 'add' | 'remove',
): string[] {
  const clean = (subnets ?? []).map(s => (s ?? '').trim()).filter(Boolean);
  if (clean.length === 0) return [];

  const prefix = op === 'remove' ? 'no ' : '';
  const stmt = (subnet: string) =>
    proc.protocol === 'ospf'
      ? `${prefix}network ${subnet} area ${proc.area ?? '0'}`
      : `${prefix}network ${subnet}`;

  const cmds = ['configure terminal', proc.routerLine];

  // BGP keeps its `network` statements inside an address family, and an IPv6
  // pool belongs to a different one than an IPv4 pool.
  if (proc.protocol === 'bgp') {
    const v4 = clean.filter(s => !s.includes(':'));
    const v6 = clean.filter(s => s.includes(':'));
    for (const [af, list] of [['ipv4', v4], ['ipv6', v6]] as const) {
      if (list.length === 0) continue;
      cmds.push(`address-family ${af} unicast`, ...list.map(stmt), 'exit-address-family');
    }
  } else {
    cmds.push(...clean.map(stmt));
  }

  cmds.push('end');
  return cmds;
}
