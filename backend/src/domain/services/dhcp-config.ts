import { cidrNetworkRange, cidrRange, ipToNum, numToIp } from './ip-utils';

// ── Kea DHCPv4 config model ─────────────────────────────────────────────────
//
// Kea rather than isc-dhcp-server or dnsmasq, deliberately:
//
//   * isc-dhcp-server is END OF LIFE upstream (ISC stopped maintaining it after
//     2022). It is still in Ubuntu 24.04, but starting a new module on it means
//     shipping an unmaintained daemon.
//   * dnsmasq would be the easy choice except that it is a DNS server too, and
//     this deployment's BIND9 is shared infrastructure owned by three other
//     modules (see CLAUDE.md pattern #4). Two daemons contending for :53 is not
//     a tradeoff worth taking for DHCP.
//   * Kea's config is JSON, so generating it is a data transform rather than a
//     bespoke config-language writer — which is also why round-tripping an
//     operator's hand edits is feasible here.
//
// The host's Kea config file is the single source of truth. There is no mirror
// of it in Mongo, for the same reason chrony-controller.ts parses chrony.conf
// directly: a second copy drifts, and the daemon only ever reads the file.

export interface DhcpPool {
  /** First assignable address, inclusive. */
  start: string;
  /** Last assignable address, inclusive. */
  end: string;
}

export interface DhcpReservation {
  /** Lower-case, colon-separated MAC. */
  mac: string;
  ip: string;
  hostname?: string;
}

export interface DhcpSubnet {
  /** Stable id, used as Kea's own subnet id and as the React key. */
  id: number;
  subnet: string;
  pools: DhcpPool[];
  routers: string[];
  dnsServers: string[];
  domainName?: string;
  /** Seconds. Kea's default is 3600. */
  leaseLifetime: number;
  reservations: DhcpReservation[];
  /**
   * Pins this subnet to one local interface, for DIRECTLY CONNECTED clients
   * only. Leave unset on a subnet reached through a relay — a relayed subnet
   * has no local interface to pin to.
   */
  iface?: string;
  /**
   * Relay agent addresses that select this subnet, emitted as Kea's
   * `relay: { ip-addresses: [...] }`.
   *
   * Normally UNNECESSARY. Kea's documented rule is that a relayed message "is
   * accepted through any interface" and "the giaddr set by the relay agent is
   * used to select the subnet for the client" — so a relay that is the remote
   * subnet's own gateway (the usual `ip helper-address` case) already selects
   * the right subnet with nothing configured here. This exists for the cases
   * Kea's own manual calls uncommon: a relay whose giaddr sits OUTSIDE the
   * subnet it is relaying for, and shared networks.
   */
  relayIps?: string[];
}

export interface DhcpConfig {
  /** Interfaces Kea listens on. Empty means Kea is configured but serving nothing. */
  interfaces: string[];
  subnets: DhcpSubnet[];
  /** Seconds; applies to any subnet that does not override it. */
  defaultLeaseLifetime: number;
  /** Answer only clients with a matching reservation. */
  reservationsOnly: boolean;
}

export const DEFAULT_LEASE_LIFETIME = 3600;

export const EMPTY_DHCP_CONFIG: DhcpConfig = {
  interfaces: [],
  subnets: [],
  defaultLeaseLifetime: DEFAULT_LEASE_LIFETIME,
  reservationsOnly: false,
};

// Host paths. Kea's packaging on Ubuntu puts the DHCPv4 config here and keeps
// memfile leases under /var/lib/kea.
export const KEA_CONF_PATH = '/etc/kea/kea-dhcp4.conf';
export const KEA_LEASES_PATH = '/var/lib/kea/kea-leases4.csv';
export const KEA_CONTROL_SOCKET = '/run/kea/kea4-ctrl-socket';
export const KEA_SERVICE = 'kea-dhcp4-server';

// ── Interfaces offered to the operator ──────────────────────────────────────

export interface DhcpInterface {
  name: string;
  /** Primary IPv4 CIDR, or null when the interface has no IPv4 address. */
  cidr: string | null;
  isDummy: boolean;
  isLoopback: boolean;
  /** Why binding here is a bad idea, if it is. Empty means it is fine. */
  warnings: string[];
  /**
   * Notes that only apply if a configured subnet actually leases out of THIS
   * interface's own address range — a /30 with one leasable address, say.
   *
   * Kept apart from `warnings` because binding to a narrow transit interface is
   * perfectly normal when every subnet served is remote and arrives through a
   * relay; surfacing these unconditionally reads as "you picked the wrong
   * interface" when nothing is wrong.
   */
  localPoolWarnings: string[];
  /** True when binding here must be refused outright. */
  blocked: boolean;
}

// Interfaces whose addresses another allocator already owns. A DHCP server
// answering on one of these hands out addresses something else believes it
// controls, so they are refused rather than warned about.
//
//   * ogstun/ogstun2 — Open5GS UE tunnels; the UPF allocates from smf.yaml's
//     own session pools.
//   * docker0 and the br-<id> bridges — Docker's IPAM assigns container
//     addresses on these. Found by running the real interface list on a live
//     host, where docker0 came back selectable.
const UPF_MANAGED = /^ogstun/;
const DOCKER_MANAGED = /^(docker\d+|br-[0-9a-f]{8,})$/;

/**
 * Parses `ip -o -4 addr show` plus `ip -o link show type dummy` into the list
 * the binding UI offers.
 *
 * Dummy interfaces are deliberately INCLUDED — this deployment carries ten of
 * them for per-service loopbacks and an operator may legitimately want to serve
 * a dummy segment. They are flagged, not hidden.
 */
export function parseDhcpInterfaces(addrOutput: string, dummyOutput: string): DhcpInterface[] {
  const dummies = new Set(
    (dummyOutput ?? '').split('\n')
      .map(l => l.split(':')[1]?.trim().split('@')[0])
      .filter((n): n is string => !!n),
  );

  const byName = new Map<string, DhcpInterface>();
  for (const line of (addrOutput ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const name = parts[1];
    const cidr = parts[3];
    if (!name || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr ?? '')) continue;
    // First address wins; an interface with several keeps its primary.
    if (byName.has(name)) continue;

    const isLoopback = name === 'lo';
    const isDummy = dummies.has(name);
    const prefix = Number(cidr.split('/')[1]);
    const warnings: string[] = [];
    const localPoolWarnings: string[] = [];
    let blocked = false;

    if (UPF_MANAGED.test(name)) {
      blocked = true;
      warnings.push(
        `${name} carries an Open5GS UE pool — the UPF allocates addresses here itself, so a DHCP server would hand out addresses the core already owns`,
      );
    }
    if (DOCKER_MANAGED.test(name)) {
      blocked = true;
      warnings.push(
        `${name} is a Docker bridge — Docker's own IPAM assigns addresses here, so a DHCP server would compete with it`,
      );
    }
    if (isLoopback) {
      blocked = true;
      warnings.push('Loopback cannot serve DHCP clients');
    }
    if (prefix >= 31) {
      localPoolWarnings.push(`${cidr} has no assignable host range (a /${prefix} leaves no usable addresses to lease)`);
    } else if (prefix === 30) {
      // Two host addresses, one of which is this interface — so exactly one is
      // leasable. Legal, and almost never what the operator intended.
      localPoolWarnings.push(`${cidr} leaves only one address to lease once this interface's own is excluded`);
    }
    if (isDummy) {
      warnings.push('Dummy interface — it has no physical segment, so only locally-originated or routed requests can reach it');
    }
    byName.set(name, { name, cidr, isDummy, isLoopback, warnings, localPoolWarnings, blocked });
  }

  // Dummies with no IPv4 address at all still appear, so the operator can see
  // why they are not selectable rather than wondering where they went.
  for (const d of dummies) {
    if (!byName.has(d)) {
      byName.set(d, {
        name: d, cidr: null, isDummy: true, isLoopback: false, blocked: true,
        warnings: ['No IPv4 address configured on this interface'],
        localPoolWarnings: [],
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface DhcpValidation {
  /** Blocking — the config is refused. */
  errors: string[];
  /** Non-blocking — saved, but the operator is told. */
  warnings: string[];
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function normalizeMac(mac: string): string {
  return (mac ?? '').trim().toLowerCase().replace(/[-.\s]/g, ':');
}

function isV4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? '')
    && ip.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
}

/**
 * Checks a config the operator is about to save.
 *
 * Everything here is a mistake Kea itself would either reject at startup (so the
 * service silently fails to come back) or accept and then behave surprisingly —
 * both of which are much harder to diagnose from the UI than a refusal.
 */
export function validateDhcpConfig(cfg: DhcpConfig, interfaces: DhcpInterface[]): DhcpValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(interfaces.map(i => [i.name, i]));

  // Ranges of every well-formed configured subnet, needed below to tell whether
  // a bound interface is one we actually lease out of.
  const subnetRanges = cfg.subnets
    .filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s.subnet))
    .map(s => cidrNetworkRange(s.subnet));
  const servesOwnRangeOf = (iface: DhcpInterface): boolean => {
    if (!iface.cidr) return false;
    const a = ipToNum(iface.cidr.split('/')[0]);
    return subnetRanges.some(r => a >= r.first && a <= r.last);
  };

  for (const name of cfg.interfaces) {
    const iface = byName.get(name);
    if (!iface) { warnings.push(`Interface ${name} does not exist on this host`); continue; }
    if (iface.blocked) { errors.push(`Cannot serve DHCP on ${name}: ${iface.warnings[0]}`); continue; }
    warnings.push(...iface.warnings.map(w => `${name}: ${w}`));
    // Only relevant when a subnet really does lease out of this interface's own
    // range. Binding a narrow transit interface to receive RELAYED requests for
    // remote subnets is normal and gets no complaint.
    if (servesOwnRangeOf(iface)) {
      warnings.push(...iface.localPoolWarnings.map(w => `${name}: ${w}`));
    }
  }

  if (cfg.subnets.length > 0 && cfg.interfaces.length === 0) {
    warnings.push('Subnets are configured but no interface is selected, so nothing will be served');
  }

  const seenSubnetIds = new Set<number>();
  const allReservedIps = new Map<string, string>();
  const allReservedMacs = new Map<string, string>();

  for (const s of cfg.subnets) {
    const label = s.subnet || `subnet ${s.id}`;
    if (seenSubnetIds.has(s.id)) errors.push(`Duplicate subnet id ${s.id}`);
    seenSubnetIds.add(s.id);

    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s.subnet)) {
      errors.push(`${label}: not a valid IPv4 CIDR`);
      continue;
    }
    const prefix = Number(s.subnet.split('/')[1]);
    if (prefix < 8 || prefix > 30) {
      errors.push(`${label}: prefix /${prefix} is outside the usable range /8–/30`);
      continue;
    }
    const net = cidrNetworkRange(s.subnet);
    const host = cidrRange(s.subnet);

    if (s.pools.length === 0 && s.reservations.length === 0) {
      warnings.push(`${label}: no pool and no reservations, so it will never lease an address`);
    }

    for (const p of s.pools) {
      if (!isV4(p.start) || !isV4(p.end)) { errors.push(`${label}: pool ${p.start}–${p.end} is not a valid range`); continue; }
      const a = ipToNum(p.start), b = ipToNum(p.end);
      if (a > b) { errors.push(`${label}: pool start ${p.start} is above its end ${p.end}`); continue; }
      if (a < host.first || b > host.last) {
        errors.push(`${label}: pool ${p.start}–${p.end} falls outside the subnet's assignable range ${numToIp(host.first)}–${numToIp(host.last)}`);
      }
    }

    // Overlapping pools inside one subnet — Kea accepts these and then leases
    // the same address twice.
    for (let i = 0; i < s.pools.length; i++) {
      for (let j = i + 1; j < s.pools.length; j++) {
        const x = s.pools[i], y = s.pools[j];
        if (!isV4(x.start) || !isV4(y.start)) continue;
        if (ipToNum(x.start) <= ipToNum(y.end) && ipToNum(y.start) <= ipToNum(x.end)) {
          errors.push(`${label}: pools ${x.start}–${x.end} and ${y.start}–${y.end} overlap`);
        }
      }
    }

    for (const r of s.routers) {
      if (!isV4(r)) { errors.push(`${label}: router ${r} is not a valid IPv4 address`); continue; }
      const n = ipToNum(r);
      if (n < net.first || n > net.last) warnings.push(`${label}: router ${r} is outside the subnet — clients will get a gateway they cannot ARP for`);
    }
    for (const d of s.dnsServers) if (!isV4(d)) errors.push(`${label}: DNS server ${d} is not a valid IPv4 address`);
    if (s.leaseLifetime <= 0) errors.push(`${label}: lease lifetime must be greater than zero`);

    for (const r of s.relayIps ?? []) {
      if (!isV4(r)) errors.push(`${label}: relay address ${r} is not a valid IPv4 address`);
    }

    // Is any bound interface's own address inside this subnet? That is what
    // separates a locally-served subnet from one that can only arrive through a
    // relay, and it is reported rather than enforced — a remote subnet with no
    // local interface is a completely normal relay configuration, not a mistake.
    const localIfaces = cfg.interfaces.filter(n => {
      const c = byName.get(n)?.cidr;
      if (!c) return false;
      const a = ipToNum(c.split('/')[0]);
      return a >= net.first && a <= net.last;
    });

    // A pin names the interface a DIRECTLY CONNECTED client arrives on, so
    // pinning to an interface that holds no address in this subnet describes a
    // path that cannot exist.
    if (s.iface) {
      const pinned = byName.get(s.iface);
      if (!pinned) {
        warnings.push(`${label}: pinned to ${s.iface}, which does not exist on this host`);
      } else if (!localIfaces.includes(s.iface)) {
        warnings.push(
          `${label}: pinned to ${s.iface}, which has no address in this subnet (${pinned.cidr ?? 'no IPv4'}) — leave the pin unset on a subnet reached through a relay`,
        );
      }
      if (s.relayIps?.length) {
        warnings.push(`${label}: both pinned to an interface and given relay addresses — a subnet is reached one way or the other`);
      }
    }

    for (const r of s.reservations) {
      const mac = normalizeMac(r.mac);
      if (!MAC_RE.test(mac)) { errors.push(`${label}: "${r.mac}" is not a valid MAC address`); continue; }
      if (!isV4(r.ip)) { errors.push(`${label}: reservation ${mac} has an invalid IP ${r.ip}`); continue; }
      const n = ipToNum(r.ip);
      // Kea refuses to start on an out-of-subnet reservation, so this must be
      // an error rather than a warning.
      if (n < net.first || n > net.last) {
        errors.push(`${label}: reservation ${r.ip} for ${mac} is outside the subnet`);
      }
      const dupIp = allReservedIps.get(r.ip);
      if (dupIp && dupIp !== mac) errors.push(`${r.ip} is reserved for two different MACs (${dupIp} and ${mac})`);
      allReservedIps.set(r.ip, mac);
      const dupMac = allReservedMacs.get(mac);
      if (dupMac && dupMac !== r.ip) errors.push(`${mac} is reserved twice, for ${dupMac} and ${r.ip}`);
      allReservedMacs.set(mac, r.ip);

      // Inside a pool is legal but means the address can also be handed to
      // someone else before this client ever asks.
      if (s.pools.some(p => isV4(p.start) && ipToNum(p.start) <= n && n <= ipToNum(p.end))) {
        warnings.push(`${label}: reservation ${r.ip} sits inside a dynamic pool — exclude it from the pool so it cannot be leased to another client first`);
      }
    }
  }

  // Two subnets covering the same addresses.
  for (let i = 0; i < cfg.subnets.length; i++) {
    for (let j = i + 1; j < cfg.subnets.length; j++) {
      const a = cfg.subnets[i], b = cfg.subnets[j];
      if (!/\//.test(a.subnet) || !/\//.test(b.subnet)) continue;
      const ra = cidrNetworkRange(a.subnet), rb = cidrNetworkRange(b.subnet);
      if (ra.first <= rb.last && rb.first <= ra.last) {
        errors.push(`Subnets ${a.subnet} and ${b.subnet} overlap`);
      }
    }
  }

  return { errors, warnings };
}

// ── Kea JSON generation / parsing ───────────────────────────────────────────

/**
 * Builds the Kea DHCPv4 config document.
 *
 * `control-socket` is always emitted so leases and a config reload can be read
 * without restarting the daemon — restarting a DHCP server drops nothing
 * permanently, but it does stall renewals, and this project's standing rule is
 * that reading something should never cost a restart.
 */
export function buildKeaConfig(cfg: DhcpConfig): Record<string, unknown> {
  return {
    Dhcp4: {
      'interfaces-config': {
        interfaces: [...cfg.interfaces],
      },
      'control-socket': {
        'socket-type': 'unix',
        'socket-name': KEA_CONTROL_SOCKET,
      },
      'lease-database': {
        type: 'memfile',
        persist: true,
        name: KEA_LEASES_PATH,
      },
      'valid-lifetime': cfg.defaultLeaseLifetime,
      // Kea's own name for "reservations only".
      'reservation-mode': cfg.reservationsOnly ? 'global' : 'all',
      'subnet4': cfg.subnets.map(s => {
        const out: Record<string, unknown> = {
          id: s.id,
          subnet: s.subnet,
          pools: s.pools.map(p => ({ pool: `${p.start} - ${p.end}` })),
          'valid-lifetime': s.leaseLifetime,
        };
        const opts: { name: string; data: string }[] = [];
        if (s.routers.length) opts.push({ name: 'routers', data: s.routers.join(', ') });
        if (s.dnsServers.length) opts.push({ name: 'domain-name-servers', data: s.dnsServers.join(', ') });
        if (s.domainName) opts.push({ name: 'domain-name', data: s.domainName });
        if (opts.length) out['option-data'] = opts;
        if (s.iface) out.interface = s.iface;
        if (s.relayIps?.length) out.relay = { 'ip-addresses': [...s.relayIps] };
        if (s.reservations.length) {
          out.reservations = s.reservations.map(r => {
            const res: Record<string, unknown> = { 'hw-address': normalizeMac(r.mac), 'ip-address': r.ip };
            if (r.hostname) res.hostname = r.hostname;
            return res;
          });
        }
        return out;
      }),
      loggers: [{
        name: 'kea-dhcp4',
        output_options: [{ output: '/var/log/kea/kea-dhcp4.log', maxsize: 10485760, maxver: 4 }],
        severity: 'INFO',
      }],
    },
  };
}

/** Reads a Kea config document back into our shape, tolerating hand edits. */
export function parseKeaConfig(raw: string): DhcpConfig {
  let doc: any;
  try { doc = JSON.parse(stripJsonComments(raw)); } catch { return { ...EMPTY_DHCP_CONFIG }; }
  const d = doc?.Dhcp4;
  if (!d || typeof d !== 'object') return { ...EMPTY_DHCP_CONFIG };

  const optOf = (arr: any, name: string): string =>
    (Array.isArray(arr) ? arr.find((o: any) => o?.name === name)?.data : '') ?? '';
  const listOf = (arr: any, name: string): string[] =>
    optOf(arr, name).split(',').map((s: string) => s.trim()).filter(Boolean);

  return {
    interfaces: Array.isArray(d['interfaces-config']?.interfaces)
      ? d['interfaces-config'].interfaces.filter((i: unknown): i is string => typeof i === 'string')
      : [],
    defaultLeaseLifetime: Number(d['valid-lifetime']) || DEFAULT_LEASE_LIFETIME,
    reservationsOnly: d['reservation-mode'] === 'global',
    subnets: (Array.isArray(d.subnet4) ? d.subnet4 : []).map((s: any, idx: number): DhcpSubnet => ({
      id: Number(s?.id) || idx + 1,
      subnet: String(s?.subnet ?? ''),
      pools: (Array.isArray(s?.pools) ? s.pools : []).flatMap((p: any) => {
        const m = String(p?.pool ?? '').split('-').map((x: string) => x.trim());
        return m.length === 2 && m[0] && m[1] ? [{ start: m[0], end: m[1] }] : [];
      }),
      routers: listOf(s?.['option-data'], 'routers'),
      dnsServers: listOf(s?.['option-data'], 'domain-name-servers'),
      domainName: optOf(s?.['option-data'], 'domain-name') || undefined,
      leaseLifetime: Number(s?.['valid-lifetime']) || Number(d['valid-lifetime']) || DEFAULT_LEASE_LIFETIME,
      iface: typeof s?.interface === 'string' ? s.interface : undefined,
      // Absent rather than empty when there is no relay block, so a config
      // round-trips byte-for-byte through parse -> build -> parse.
      relayIps: relayIpsOf(s),
      reservations: (Array.isArray(s?.reservations) ? s.reservations : []).flatMap((r: any) => {
        const mac = normalizeMac(String(r?.['hw-address'] ?? ''));
        const ip = String(r?.['ip-address'] ?? '');
        return mac && ip ? [{ mac, ip, hostname: r?.hostname ? String(r.hostname) : undefined }] : [];
      }),
    })),
  };
}

function relayIpsOf(subnet: any): string[] | undefined {
  const raw = subnet?.relay?.['ip-addresses'];
  if (!Array.isArray(raw)) return undefined;
  const ips = raw
    .filter((a: unknown): a is string => typeof a === 'string' && !!a.trim())
    .map((a: string) => a.trim());
  return ips.length > 0 ? ips : undefined;
}

// Kea ships its stock config with // comments, which are valid for Kea's own
// parser but not for JSON.parse.
function stripJsonComments(raw: string): string {
  return (raw ?? '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

// ── Lease reading ───────────────────────────────────────────────────────────

export interface DhcpLease {
  ip: string;
  mac: string;
  hostname: string | null;
  /** Absolute expiry, unix seconds. */
  expiresAt: number;
  /** Seconds remaining; negative once expired. */
  expiresInSeconds: number;
  subnetId: number;
  state: 'active' | 'declined' | 'expired' | 'released';
  /** True when a configured reservation pins this address. */
  reserved: boolean;
}

// Kea's memfile columns, in order, as of 2.4.x.
const LEASE_COLS = [
  'address', 'hwaddr', 'client_id', 'valid_lifetime', 'expire', 'subnet_id',
  'fqdn_fwd', 'fqdn_rev', 'hostname', 'state', 'user_context', 'pool_id',
];

/**
 * Parses Kea's memfile lease CSV.
 *
 * Two properties of this file drive the whole implementation and are easy to
 * get wrong:
 *
 *   1. It is APPEND-ONLY. A renewed, released or expired lease is written as a
 *      NEW row for the same address — so the file routinely holds several rows
 *      per IP and only the LAST one is current. Taking the first (or counting
 *      rows) over-reports active leases, often wildly.
 *   2. A released lease is recorded as `valid_lifetime 0`, NOT by removing the
 *      row, so it has to be distinguished from an assigned one explicitly.
 *
 * `reservedIps` marks addresses a reservation pins, so the UI can tell a static
 * binding apart from a dynamic lease of the same address.
 */
export function parseKeaLeases(
  csv: string,
  nowSeconds: number,
  reservedIps: Set<string> = new Set(),
): DhcpLease[] {
  const lines = (csv ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Honour the header when present rather than assuming column order — Kea has
  // added columns across versions (pool_id arrived in 2.0).
  let cols = LEASE_COLS;
  let start = 0;
  if (lines[0].startsWith('address,')) {
    cols = lines[0].split(',').map(c => c.trim());
    start = 1;
  }
  const idx = (name: string) => cols.indexOf(name);
  const iAddr = idx('address'), iMac = idx('hwaddr'), iLife = idx('valid_lifetime');
  const iExp = idx('expire'), iSub = idx('subnet_id'), iHost = idx('hostname'), iState = idx('state');
  if (iAddr === -1) return [];

  // Last row per address wins (property 1 above).
  const latest = new Map<string, string[]>();
  for (let i = start; i < lines.length; i++) {
    const f = lines[i].split(',');
    const addr = f[iAddr]?.trim();
    if (!addr || !isV4(addr)) continue;
    latest.set(addr, f);
  }

  const out: DhcpLease[] = [];
  for (const [ip, f] of latest) {
    const lifetime = Number(f[iLife] ?? 0);
    const expiresAt = Number(f[iExp] ?? 0);
    const rawState = Number(f[iState] ?? 0);
    let state: DhcpLease['state'];
    if (lifetime === 0) state = 'released';          // property 2
    else if (rawState === 1) state = 'declined';
    else if (rawState === 2 || expiresAt <= nowSeconds) state = 'expired';
    else state = 'active';

    out.push({
      ip,
      mac: normalizeMac(f[iMac] ?? ''),
      hostname: (f[iHost] ?? '').trim() || null,
      expiresAt,
      expiresInSeconds: expiresAt - nowSeconds,
      subnetId: Number(f[iSub] ?? 0),
      state,
      reserved: reservedIps.has(ip),
    });
  }

  // Active first, then by address — an operator opening this page wants the
  // live clients, not whatever Kea wrote most recently.
  const rank = (s: DhcpLease['state']) => (s === 'active' ? 0 : s === 'declined' ? 1 : s === 'expired' ? 2 : 3);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || ipToNum(a.ip) - ipToNum(b.ip));
}

/** Every address pinned by a reservation, across all subnets. */
export function reservedIpsOf(cfg: DhcpConfig): Set<string> {
  return new Set(cfg.subnets.flatMap(s => s.reservations.map(r => r.ip)));
}
