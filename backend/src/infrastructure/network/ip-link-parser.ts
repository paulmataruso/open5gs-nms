// Shared `ip -o link show` / `ip -o addr show` parsing, extracted from
// tun-management.ts's list() (which layers its own ogstun-only filter on top of
// this). Returns EVERY interface unfiltered — used by the packet-capture module's
// "all host interfaces" picker, which needs lo/ens20/dummy-*/veth-*/ogstun* etc.,
// not just the TUN-focused subset tun-management.ts cares about for its own page.
export interface HostInterface {
  name: string;
  ip: string;
  prefix: number;
  state: 'up' | 'down';
}

export function parseIpLinkAddr(linkOutput: string, addrOutput: string): HostInterface[] {
  // Parse link — detect UP from flags field, not "state" keyword (TUN interfaces
  // always show "state DOWN" due to NO-CARRIER even when the UP flag is set).
  const stateMap = new Map<string, 'up' | 'down'>();
  for (const line of linkOutput.split('\n')) {
    const m = line.match(/^\d+:\s+([^:@\s]+)/);
    if (!m) continue;
    const flagsMatch = line.match(/<([^>]+)>/);
    const flags = flagsMatch ? flagsMatch[1].split(',') : [];
    stateMap.set(m[1], flags.includes('UP') ? 'up' : 'down');
  }

  // Parse addr: first IPv4 assignment per interface (an interface can have more
  // than one; the picker only needs one representative address per interface).
  const addrMap = new Map<string, { ip: string; prefix: number }>();
  for (const line of addrOutput.split('\n')) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (!m || addrMap.has(m[1])) continue;
    addrMap.set(m[1], { ip: m[2], prefix: parseInt(m[3]) });
  }

  return [...stateMap.keys()].sort().map(name => ({
    name,
    ip: addrMap.get(name)?.ip ?? '',
    prefix: addrMap.get(name)?.prefix ?? 0,
    state: stateMap.get(name) ?? 'down',
  }));
}
