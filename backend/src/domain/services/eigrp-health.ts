// ── EIGRP forwarding-health diagnosis ─────────────────────────────────────
//
// Pure parsing and judgement for the failure modes this deployment has
// actually suffered (CLAUDE.md pattern #7, seven confirmed occurrences). Kept
// free of any host execution so the rules can be unit-tested against real
// captured output rather than only exercised against a live router.
//
// The distinction that matters, and the one this project got wrong before:
// a corrupt EIGRP topology is NOT by itself an outage. The 6th occurrence
// (2026-10-10) had a thoroughly corrupt topology and a perfectly clean kernel
// route table, and nothing was broken. What breaks traffic is the kernel
// route table — so the topology is treated as a WARNING and the kernel as the
// thing worth interrupting service to repair.
//
// The two kernel-visible signatures, both measured on this host:
//
//   1. A nexthop that is in use by a route but carries no gateway
//      ("id N dev ens20 scope host", no `via`). Produced by
//      eigrp_zebra_route_add() reading a freed neighbour whose memory happens
//      to read zero: it falls to NEXTHOP_TYPE_IFINDEX and hands the kernel an
//      on-link nexthop for a segment the destination is not on. Under ECMP
//      hashing some flows resolve and others blackhole, which is why it
//      presents as "some radios work".
//
//   2. A prefix EIGRP believes it has installed, with no kernel route at all.
//      Measured after a transit-link flap: zebra holds the route as
//      "Status: Changed, Flags: None" and never installs it, because the
//      nexthop it still points at lost its gateway while the link was down.

export interface EigrpTopologyEntry {
  /** Advertising router as printed, or 'Connected' for a local prefix. */
  via: string;
  connected: boolean;
}

export interface EigrpTopologyPrefix {
  prefix: string;
  successors: number;
  entries: EigrpTopologyEntry[];
}

export interface KernelNexthop {
  id: number;
  /** Gateway address, or null when the row carries none. */
  via: string | null;
  /** Member ids for a group row; empty for a leaf. */
  group: number[];
}

export interface KernelRoute {
  prefix: string;
  nhid: number | null;
  via: string | null;
  proto: string | null;
}

export type EigrpFindingKind =
  | 'vialess-nexthop-in-use'
  | 'missing-kernel-route'
  | 'topology-corruption';

export interface EigrpFinding {
  kind: EigrpFindingKind;
  /** True when this finding means traffic is being dropped right now. */
  trafficAffecting: boolean;
  detail: string;
  prefixes: string[];
}

export interface EigrpHealth {
  findings: EigrpFinding[];
  /** Any finding that justifies interrupting the service to repair it. */
  degraded: boolean;
  topologyPrefixes: number;
  corruptPrefixes: number;
}

// ── parsing ───────────────────────────────────────────────────────────────

/** Parses `vtysh -c "show ip eigrp topology"`. */
export function parseEigrpTopology(text: string): EigrpTopologyPrefix[] {
  const out: EigrpTopologyPrefix[] = [];
  for (const raw of text.split('\n')) {
    const head = raw.match(/^P\s+(\S+?),\s+(\d+)\s+successors/);
    if (head) {
      out.push({ prefix: head[1], successors: Number(head[2]), entries: [] });
      continue;
    }
    // Continuation lines are indented; ignore anything before the first prefix.
    const viaLine = raw.match(/^\s+via\s+(Connected|\S+?)[\s,(]/);
    if (viaLine && out.length > 0) {
      const via = viaLine[1];
      out[out.length - 1].entries.push({ via, connected: via === 'Connected' });
    }
  }
  return out;
}

/**
 * Parses `vtysh -c "show ip eigrp neighbors"` into the set of addresses that
 * are genuinely adjacent right now.
 *
 * This is what makes a stale descriptor identifiable. The measured corruption
 * showed next hops like 32.75.32.23, 81.0.0.0 and 0.10.0.0 — freed memory read
 * as an address — and an earlier version of this file tried to catch them by
 * looking for the same router listed twice. That misses the common case: one
 * garbage entry beside one real one are different strings, so nothing is
 * duplicated. "Not a current neighbour" is the property that actually holds.
 */
export function parseEigrpNeighbors(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    // "0   192.168.253.1     ens20   12   0   0   2   0   2533"
    const m = raw.match(/^\s*\d+\s+(\d+\.\d+\.\d+\.\d+)\s/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Parses `ip nexthop show`. */
export function parseKernelNexthops(text: string): KernelNexthop[] {
  const out: KernelNexthop[] = [];
  for (const raw of text.split('\n')) {
    const id = raw.match(/^id\s+(\d+)\s/);
    if (!id) continue;
    const via = raw.match(/\svia\s+(\S+)/);
    const group = raw.match(/\sgroup\s+(\S+)/);
    out.push({
      id: Number(id[1]),
      via: via ? via[1] : null,
      // Group members are "85" or "85/90", and a weighted member is "85,1".
      group: group
        ? group[1].split('/').map(part => Number(part.split(',')[0])).filter(n => Number.isFinite(n))
        : [],
    });
  }
  return out;
}

/** Parses `ip route show`. */
export function parseKernelRoutes(text: string): KernelRoute[] {
  const out: KernelRoute[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('nexthop')) continue;
    const first = line.split(/\s+/)[0];
    if (!/^(default|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?)$/.test(first)) continue;
    const nhid = line.match(/\snhid\s+(\d+)/);
    const via = line.match(/\svia\s+(\S+)/);
    const proto = line.match(/\sproto\s+(\S+)/);
    out.push({
      prefix: first,
      nhid: nhid ? Number(nhid[1]) : null,
      via: via ? via[1] : null,
      proto: proto ? proto[1] : null,
    });
  }
  return out;
}

// ── diagnosis ─────────────────────────────────────────────────────────────

/**
 * Resolves a route's nexthop id to the leaf rows it actually forwards through.
 * A group row carries no gateway of its own, so judging the group row itself
 * would report every multipath route as gateway-less.
 */
function leafNexthops(id: number, byId: Map<number, KernelNexthop>, seen = new Set<number>()): KernelNexthop[] {
  if (seen.has(id)) return []; // defensive: a self-referential group would otherwise spin
  seen.add(id);
  const nh = byId.get(id);
  if (!nh) return [];
  if (nh.group.length === 0) return [nh];
  return nh.group.flatMap(member => leafNexthops(member, byId, seen));
}

export function diagnoseEigrpHealth(input: {
  topology: string;
  routes: string;
  nexthops: string;
  /**
   * `show ip eigrp neighbors`. Optional only so a caller that cannot read it
   * still gets the two kernel findings; without it the topology check falls
   * back to the weaker duplicate-router rule.
   */
  neighbors?: string;
  /**
   * Prefixes whose kernel route this deployment depends on. Only these drive
   * the missing-route finding: EIGRP legitimately learns prefixes it does not
   * install (a worse path, a filtered one), so "in the topology but not in the
   * kernel" is normal in general and only a fault for routes we know we need.
   */
  requiredPrefixes?: string[];
}): EigrpHealth {
  const topology = parseEigrpTopology(input.topology);
  const routes = parseKernelRoutes(input.routes);
  const nexthops = parseKernelNexthops(input.nexthops);
  const byId = new Map(nexthops.map(nh => [nh.id, nh]));
  const findings: EigrpFinding[] = [];

  // 1. Gateway-less nexthop actually in use by a route.
  const vialess: string[] = [];
  for (const route of routes) {
    if (route.nhid === null) continue;
    const leaves = leafNexthops(route.nhid, byId);
    if (leaves.length === 0) continue;
    if (leaves.some(leaf => leaf.via === null)) vialess.push(route.prefix);
  }
  if (vialess.length > 0) {
    findings.push({
      kind: 'vialess-nexthop-in-use',
      trafficAffecting: true,
      detail: `${vialess.length} kernel route(s) forward through a nexthop with no gateway, which the kernel treats as on-link; under ECMP hashing part of each prefix blackholes`,
      prefixes: vialess,
    });
  }

  // 2. A required prefix with no kernel route.
  const required = input.requiredPrefixes ?? [];
  if (required.length > 0) {
    const installed = new Set(routes.map(r => r.prefix));
    const known = new Set(topology.map(p => p.prefix));
    const missing = required.filter(p => known.has(p) && !installed.has(p));
    if (missing.length > 0) {
      findings.push({
        kind: 'missing-kernel-route',
        trafficAffecting: true,
        detail: `${missing.length} prefix(es) are in EIGRP's topology but have no kernel route; zebra holds these without installing them after a link flap`,
        prefixes: missing,
      });
    }
  }

  // 3. Topology corruption. Reported, never acted on by itself — see the file
  // header: the 6th occurrence had exactly this with a clean kernel and no
  // outage, and restarting on it alone means interrupting a working network.
  const neighbors = input.neighbors ? parseEigrpNeighbors(input.neighbors) : null;
  const corrupt = topology.filter(p => {
    const named = p.entries.filter(e => !e.connected).map(e => e.via);
    // Primary rule: a next hop that is not currently adjacent. A stale
    // descriptor's address comes from freed memory, so it is either junk or an
    // old neighbour — either way not in this set. Only meaningful when we were
    // actually able to read the neighbour table AND it is non-empty; an empty
    // one means every adjacency is down, where every entry is legitimately
    // pending removal rather than corrupt.
    if (neighbors && neighbors.size > 0) {
      if (named.some(via => !neighbors.has(via))) return true;
    }
    // Fallback, and still worth checking on its own: the same router listed
    // twice for one prefix. Genuine multipath never repeats an advertiser.
    if (p.successors <= 1) return false;
    return new Set(named).size !== named.length;
  });
  if (corrupt.length > 0) {
    findings.push({
      kind: 'topology-corruption',
      trafficAffecting: false,
      detail: `${corrupt.length} prefix(es) name a next hop that is not a current neighbour, or name one twice, which indicates stale route descriptors; the kernel table is the authority on whether traffic is affected`,
      prefixes: corrupt.map(p => p.prefix),
    });
  }

  return {
    findings,
    degraded: findings.some(f => f.trafficAffecting),
    topologyPrefixes: topology.length,
    corruptPrefixes: corrupt.length,
  };
}
