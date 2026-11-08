/**
 * Auto-Configuration planner — turns an operator's IP range into a complete
 * allocation for every service that needs its own address.
 *
 * Deliberately PURE, in two stages, because the two decisions fail in
 * different ways and are worth testing apart:
 *
 *   1. `buildAutoconfigContext()` validates the AUTOCONFIG_* env and works out
 *      the subnet, the gateway and how far it may scan. No addresses yet.
 *   2. `allocateAddresses()` assigns actual addresses, skipping any the caller
 *      reports as already in use on the network.
 *
 * The orchestrator does the probing (ping + ARP) and feeds the results in, so
 * allocation itself needs no host, container or network to test.
 *
 * Scope, per the operator's design: a SINGLE L2 interface. Every address is a
 * secondary address on one NIC inside the gateway's subnet — no dummy
 * interfaces, no routed /32s. That is a different model from this deployment's
 * own reference host (dummies plus OSPF) and the simpler one to build from
 * nothing.
 */

import { ipToNum, numToIp } from './ip-utils';

/**
 * Every service that needs its OWN routable address, in FROZEN order.
 *
 * The order is a compatibility contract: an operator who upgrades must not
 * find every service re-addressed. New services are APPENDED, never inserted,
 * and nothing is removed — a retired entry becomes a reserved hole rather than
 * shifting its successors.
 *
 * Verified against the reference host's live listeners rather than its config,
 * so every entry genuinely binds an address. Anything binding a wildcard or a
 * loopback is deliberately absent, because an address for it would be wasted:
 * nginx, SASBench, Grafana, the NMS backend, MongoDB, chrony (123), snmpd
 * (161), osmo-bsc's OML/RSL (3002/3003), osmo-sgsn's Gb (23000), osmo-msc's
 * SMPP (2775), HNBGW's Iuh (29169), every NF's SBI (127.0.0.x), I/S-CSCF
 * (127.0.1.1/.2), Asterisk (127.0.1.4), Asterisk-2G (127.0.1.7), SigScale OCS
 * (127.0.1.10) and PyHSS's AAA (127.0.0.11).
 *
 * `sharesPortWith` records why an entry cannot be merged into another. Three
 * pairs are structurally un-mergeable: UPF and SGW-U both bind udp/2152, ePDG
 * and SecGW both bind udp/500+4500, P-CSCF and the PSTN trunk both bind 5060.
 */
export interface AutoconfigService {
  /** Stable key used in the manifest and by each module to find its address. */
  key: string;
  label: string;
  /** Ports it binds — for the plan report and the docs. */
  ports: string;
  /** Another service key it collides with on port, if any. */
  sharesPortWith?: string;
  /** Short name used to build its FQDN under the EPC/5GC zone. */
  fqdnLabel: string;
}

export const AUTOCONFIG_SERVICES: readonly AutoconfigService[] = [
  { key: 'amfNgap',   label: 'AMF NGAP (N2)',         ports: 'sctp/38412',               fqdnLabel: 'amf' },
  { key: 'upfGtpu',   label: 'UPF GTP-U (N3)',        ports: 'udp/2152', sharesPortWith: 'sgwuGtpu', fqdnLabel: 'upf' },
  { key: 'mmeS1ap',   label: 'MME S1-MME (S1AP)',     ports: 'sctp/36412',               fqdnLabel: 'mme' },
  { key: 'sgwuGtpu',  label: 'SGW-U GTP-U (S1-U)',    ports: 'udp/2152', sharesPortWith: 'upfGtpu',  fqdnLabel: 'sgwu' },
  { key: 'pcscf',     label: 'P-CSCF + rtpengine',    ports: 'udp,tcp/5060 + RTP range', sharesPortWith: 'pstnTrunk', fqdnLabel: 'pcscf' },
  { key: 'mmsc',      label: 'VectorCore MMSC (MM1)', ports: 'tcp/8002',                 fqdnLabel: 'mms' },
  { key: 'dns',       label: 'BIND DNS',              ports: 'udp,tcp/53',               fqdnLabel: 'ns' },
  { key: 'epdg',      label: 'ePDG (VoWiFi)',         ports: 'udp/500,4500,2123,2152', sharesPortWith: 'secgw', fqdnLabel: 'epdg' },
  { key: 'secgw',     label: 'Security Gateway',      ports: 'udp/500,4500', sharesPortWith: 'epdg', fqdnLabel: 'secgw' },
  { key: 'pstnTrunk', label: 'PSTN external trunk',   ports: 'udp/5060', sharesPortWith: 'pcscf',    fqdnLabel: 'pstn' },
] as const;

export const DEFAULT_SECGW_POOL_SIZE = 8;

export interface AutoconfigEnv {
  enabled: boolean;
  interfaceName: string | null;
  startIp: string | null;
  gateway: string | null;
  /** Dotted-quad netmask (what an operator writes) or a /prefix. */
  subnet: string | null;
  secgwPoolSize: number;
  /**
   * Skip duplicate-address detection entirely and allocate straight up from
   * the start address.
   *
   * An explicit opt-out for an operator who already knows the range is free.
   * It makes the allocation fully deterministic and contiguous, costs no
   * probe time, and puts no ARP or ICMP on the segment. The trade is real and
   * entirely theirs: nothing then stops this from binding an address another
   * host already owns, and the symptom of that shows up on the OTHER host.
   */
  skipIpCheck: boolean;
}

export function readAutoconfigEnv(env: Record<string, string | undefined>): AutoconfigEnv {
  const size = Number(env.AUTOCONFIG_SECGW_POOL_SIZE);
  return {
    enabled: env.AUTOCONFIG_ENABLED === 'true',
    interfaceName: env.AUTOCONFIG_INTERFACE?.trim() || null,
    startIp: env.AUTOCONFIG_START_IP?.trim() || null,
    gateway: env.AUTOCONFIG_GW?.trim() || null,
    subnet: env.AUTOCONFIG_SUBNET?.trim() || null,
    secgwPoolSize: Number.isInteger(size) && size > 0 ? size : DEFAULT_SECGW_POOL_SIZE,
    // Opt-out, so a deployment that sets nothing still gets checked.
    skipIpCheck: env.AUTOCONFIG_SKIP_IP_CHECK?.trim().toLowerCase() === 'true',
  };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidIpv4(ip: string): boolean {
  const m = IPV4.exec(ip.trim());
  if (!m) return false;
  return m.slice(1).every(o => {
    const n = Number(o);
    // Reject a leading zero: '010' is octal to some parsers and ambiguous here.
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

/**
 * Accepts a dotted-quad netmask or a `/prefix`, returning the prefix length.
 *
 * A netmask must be CONTIGUOUS — 255.255.0.255 is not one, and treating it as
 * one would produce a nonsense subnet that only fails later, on the host, as
 * unreachable addresses.
 */
export function netmaskToPrefix(subnet: string): number | null {
  const s = subnet.trim();
  const slash = /^\/?(\d{1,2})$/.exec(s);
  if (slash) {
    const p = Number(slash[1]);
    return p >= 0 && p <= 32 ? p : null;
  }
  if (!isValidIpv4(s)) return null;
  const n = ipToNum(s);
  const inv = (~n) >>> 0;
  if (((inv + 1) & inv) !== 0) return null;   // not contiguous
  let prefix = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) prefix++;
    else break;
  }
  return prefix;
}

export interface PlanError {
  field: string;
  message: string;
}

/** Validated planning context — the subnet and the window addresses may come from. */
export interface AutoconfigContext {
  interfaceName: string | null;
  network: string;
  prefix: number;
  gateway: string;
  /** First address to consider. */
  startIp: string;
  /** Last address that may be used — one below the broadcast. */
  lastUsableIp: string;
  secgwPoolSize: number;
  /** How many addresses the allocation needs in total, if nothing is skipped. */
  minimumNeeded: number;
  /** Candidate addresses to probe and allocate from, in order. */
  candidates: string[];
}

export function buildAutoconfigContext(
  env: AutoconfigEnv,
): { ok: true; context: AutoconfigContext } | { ok: false; errors: PlanError[] } {
  const errors: PlanError[] = [];

  if (!env.startIp) errors.push({ field: 'AUTOCONFIG_START_IP', message: 'required when AUTOCONFIG_ENABLED=true' });
  else if (!isValidIpv4(env.startIp)) errors.push({ field: 'AUTOCONFIG_START_IP', message: `not a valid IPv4 address: ${env.startIp}` });

  if (!env.gateway) errors.push({ field: 'AUTOCONFIG_GW', message: 'required when AUTOCONFIG_ENABLED=true' });
  else if (!isValidIpv4(env.gateway)) errors.push({ field: 'AUTOCONFIG_GW', message: `not a valid IPv4 address: ${env.gateway}` });

  const prefix = env.subnet ? netmaskToPrefix(env.subnet) : null;
  if (!env.subnet) errors.push({ field: 'AUTOCONFIG_SUBNET', message: 'required when AUTOCONFIG_ENABLED=true' });
  else if (prefix === null) {
    errors.push({
      field: 'AUTOCONFIG_SUBNET',
      message: `not a valid netmask or /prefix: ${env.subnet} (a netmask must be contiguous, e.g. 255.255.255.0 or /24)`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const startNum = ipToNum(env.startIp as string);
  const gwNum = ipToNum(env.gateway as string);
  const p = prefix as number;
  const mask = p === 0 ? 0 : ((~0 << (32 - p)) >>> 0);
  const netNum = (startNum & mask) >>> 0;
  const broadcast = (netNum | ((~mask) >>> 0)) >>> 0;
  const lastUsable = broadcast - 1;
  const minimumNeeded = AUTOCONFIG_SERVICES.length + env.secgwPoolSize;

  if (p >= 31) {
    errors.push({ field: 'AUTOCONFIG_SUBNET', message: `/${p} has no usable host range; use /30 or larger` });
  }
  if (((gwNum & mask) >>> 0) !== netNum) {
    errors.push({
      field: 'AUTOCONFIG_GW',
      message: `gateway ${env.gateway} is not inside ${numToIp(netNum)}/${p} — the start address and gateway must share one L2 subnet`,
    });
  }
  if (startNum <= netNum) {
    errors.push({ field: 'AUTOCONFIG_START_IP', message: `${env.startIp} is the network address of ${numToIp(netNum)}/${p} or below it` });
  }
  if (p < 31 && startNum + minimumNeeded - 1 > lastUsable) {
    errors.push({
      field: 'AUTOCONFIG_START_IP',
      message:
        `need at least ${minimumNeeded} addresses (${AUTOCONFIG_SERVICES.length} services + ${env.secgwPoolSize} SecGW pool) ` +
        `from ${env.startIp}, but only ${Math.max(0, lastUsable - startNum + 1)} remain below the broadcast address ` +
        `${numToIp(broadcast)} of ${numToIp(netNum)}/${p}. Start lower or widen the subnet.`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Candidates run from the start address to the last usable address, with the
  // gateway excluded outright — claiming it would black-hole the whole host.
  const candidates: string[] = [];
  for (let n = startNum; n <= lastUsable; n++) {
    if (n === gwNum) continue;
    candidates.push(numToIp(n));
  }

  return {
    ok: true,
    context: {
      interfaceName: env.interfaceName,
      network: numToIp(netNum),
      prefix: p,
      gateway: env.gateway as string,
      startIp: env.startIp as string,
      lastUsableIp: numToIp(lastUsable),
      secgwPoolSize: env.secgwPoolSize,
      minimumNeeded,
      candidates,
    },
  };
}

export interface AllocatedAddress {
  key: string;
  label: string;
  ports: string;
  fqdnLabel: string;
  ip: string;
}

export interface AutoconfigPlan {
  interfaceName: string | null;
  network: string;
  prefix: number;
  gateway: string;
  services: AllocatedAddress[];
  /** Per-radio SecGW tunnel addresses — never a shared selector (pattern #15). */
  secgwPool: string[];
  /** CIDR covering secgwPool; SecGW's Configure takes this, so the run must be aligned. */
  secgwPoolCidr: string;
  allAddresses: string[];
  /** Addresses found occupied and stepped over, for the record. */
  skipped: string[];
}

/** True when `ip` is already in use on the network. */
export type TakenPredicate = (ip: string) => boolean;

/**
 * Assigns addresses, stepping over any already in use.
 *
 * Per-service addresses may be non-contiguous — each service simply takes the
 * next free candidate. The SecGW pool cannot: SecGW's Configure takes a single
 * CIDR, from which `allocatePoolAddress()` later hands each radio one address,
 * so the pool needs a free run that is also CIDR-ALIGNED (a /29 must start on
 * a multiple of 8) for the mask to describe exactly those addresses and no
 * others. A pool expressed as a CIDR that covered an occupied address would
 * hand that address to a radio.
 */
export function allocateAddresses(
  ctx: AutoconfigContext,
  isTaken: TakenPredicate,
): { ok: true; plan: AutoconfigPlan } | { ok: false; errors: PlanError[] } {
  const skipped: string[] = [];
  const free = (ip: string) => {
    if (!isTaken(ip)) return true;
    if (!skipped.includes(ip)) skipped.push(ip);
    return false;
  };

  const services: AllocatedAddress[] = [];
  let i = 0;
  for (const svc of AUTOCONFIG_SERVICES) {
    while (i < ctx.candidates.length && !free(ctx.candidates[i])) i++;
    if (i >= ctx.candidates.length) {
      return {
        ok: false,
        errors: [{
          field: 'AUTOCONFIG_START_IP',
          message:
            `ran out of free addresses between ${ctx.startIp} and ${ctx.lastUsableIp} while allocating ` +
            `"${svc.label}". ${skipped.length} address(es) were already in use on the network ` +
            `(${skipped.slice(0, 12).join(', ')}${skipped.length > 12 ? ', …' : ''}). ` +
            `Widen the subnet or pick a quieter range.`,
        }],
      };
    }
    services.push({ key: svc.key, label: svc.label, ports: svc.ports, fqdnLabel: svc.fqdnLabel, ip: ctx.candidates[i] });
    i++;
  }

  // Aligned, contiguous free run for the pool, searched from where services ended.
  const size = ctx.secgwPoolSize;
  const blockPrefix = 32 - Math.ceil(Math.log2(Math.max(1, size)));
  const blockSpan = 2 ** (32 - blockPrefix);
  const lastUsableNum = ipToNum(ctx.lastUsableIp);
  const gwNum = ipToNum(ctx.gateway);
  const searchFrom = services.length > 0 ? ipToNum(services[services.length - 1].ip) + 1 : ipToNum(ctx.startIp);

  let poolStart: number | null = null;
  // Step through aligned blocks only.
  let probe = Math.ceil(searchFrom / blockSpan) * blockSpan;
  for (; probe + blockSpan - 1 <= lastUsableNum; probe += blockSpan) {
    let allFree = true;
    for (let k = 0; k < size; k++) {
      const n = probe + k;
      if (n === gwNum) { allFree = false; break; }
      if (!free(numToIp(n))) { allFree = false; break; }
    }
    if (allFree) { poolStart = probe; break; }
  }

  if (poolStart === null) {
    return {
      ok: false,
      errors: [{
        field: 'AUTOCONFIG_SECGW_POOL_SIZE',
        message:
          `could not find ${size} consecutive free addresses on a /${blockPrefix} boundary between ` +
          `${numToIp(searchFrom)} and ${ctx.lastUsableIp} for the SecGW per-radio pool. ` +
          `SecGW takes a single CIDR, so this block must be aligned and entirely free. ` +
          `Widen the subnet, lower AUTOCONFIG_SECGW_POOL_SIZE, or pick a quieter range.`,
      }],
    };
  }

  const secgwPool = Array.from({ length: size }, (_, k) => numToIp(poolStart + k));

  return {
    ok: true,
    plan: {
      interfaceName: ctx.interfaceName,
      network: ctx.network,
      prefix: ctx.prefix,
      gateway: ctx.gateway,
      services,
      secgwPool,
      secgwPoolCidr: `${secgwPool[0]}/${blockPrefix}`,
      allAddresses: [...services.map(s => s.ip), ...secgwPool],
      skipped,
    },
  };
}

export function planAddress(plan: AutoconfigPlan, key: string): string | null {
  return plan.services.find(s => s.key === key)?.ip ?? null;
}

/**
 * Human-readable summary, logged before anything is bound.
 *
 * Printed deliberately: this binds addresses on a shared L2 segment, and an
 * operator who mistyped a range should see exactly what is about to be claimed
 * — and which addresses were found occupied — before it happens.
 */
export function describePlan(plan: AutoconfigPlan): string {
  const lines = [
    `Auto-Configuration plan — ${plan.allAddresses.length} addresses on ${plan.interfaceName ?? '(auto-detected interface)'}`,
    `  subnet ${plan.network}/${plan.prefix}  gateway ${plan.gateway}`,
  ];
  for (const s of plan.services) lines.push(`  ${s.ip.padEnd(15)} ${s.label} (${s.ports})`);
  lines.push(`  ${plan.secgwPoolCidr.padEnd(15)} SecGW per-radio pool: ${plan.secgwPool[0]}–${plan.secgwPool[plan.secgwPool.length - 1]}`);
  if (plan.skipped.length > 0) {
    lines.push(`  skipped ${plan.skipped.length} address(es) already in use: ${plan.skipped.join(', ')}`);
  }
  return lines.join('\n');
}
