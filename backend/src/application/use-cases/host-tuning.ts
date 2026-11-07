import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';

// ── GTP-U socket buffer sizing ──────────────────────────────────────────────
//
// Open5GS sets socket buffer sizes NOWHERE. Verified against the v2.8.0 source:
// `grep -rn "SO_SNDBUF\|SO_RCVBUF" lib/ src/` returns nothing, `ogs_sockopt_t`
// (lib/core/ogs-sockopt.h) carries only SCTP params / nodelay / linger /
// so_bindtodevice, and `ogs_udp_server()` applies only so_bindtodevice. So every
// GTP-U socket runs at exactly net.core.{r,w}mem_default and NO Open5GS YAML
// option can change it — the kernel default is the only lever.
//
// On the stock 212992-byte (208 KB) default that is roughly 90 ms of buffering at
// 11.5 Mbps. Measured on a real deployment 2026-11-01: 53435 UDP RcvbufErrors
// (uplink GTP-U discarded before the UPF could read it) and 348 SndbufErrors. The
// send side surfaces in upf.log as
//   "ogs_sendto() failed (11: Resource temporarily unavailable)"
// at lib/gtp/path.c:153, inside ogs_gtp_send_with_teid(), which DISCARDS the
// packet and returns OGS_ERROR with no retry. The receive side is silent — it is
// only visible in /proc/net/snmp and `ss -uanpm`'s per-socket drop counter, which
// is why it went unnoticed while being 153x the volume of the errors that did log.
//
// Deliberately a sysctl rather than a patched Open5GS: this covers both directions
// for every GTP-U socket at once (UPF, SGW-U and osmo-ggsn) and survives an
// Open5GS upgrade, whereas a local patch has to be re-applied after every rebuild
// — a failure mode this project has already suffered four times with Kamailio
// modules (see CLAUDE.md's static-template/stale-build entries).
//
// These are limits, not reservations: the kernel charges only actually-queued
// bytes, and net.ipv4.udp_mem still caps total UDP memory.
export const GTPU_SYSCTL_PATH = '/etc/sysctl.d/99-open5gs-gtpu-buffers.conf';

/** ~1.7 s of buffering at 11.5 Mbps, vs ~90 ms on the 212992 stock default. */
export const GTPU_SOCKET_BUFFER_BYTES = 4194304;
/** Ceiling for anything that explicitly asks; the stock default leaves max == default. */
export const GTPU_SOCKET_BUFFER_MAX_BYTES = 16777216;
/** Stock 1000 is low for a multi-radio data plane (306595 device RX drops observed). */
export const NETDEV_MAX_BACKLOG = 16384;

export function gtpuSysctlContent(): string {
  return [
    '# Open5GS GTP-U socket buffers — written by open5gs-nms (host-tuning.ts).',
    '#',
    '# Open5GS never calls setsockopt(SO_RCVBUF/SO_SNDBUF), so every GTP-U socket',
    '# inherits net.core.{r,w}mem_default. The stock 212992 is ~90ms of buffering',
    '# at 11.5 Mbps and overflows under real load: uplink packets are dropped',
    '# before the UPF can read them (UDP RcvbufErrors in /proc/net/snmp), and',
    '# downlink sends fail with EAGAIN, logged by upf.log as',
    '# "ogs_sendto() failed (11: Resource temporarily unavailable)".',
    '#',
    '# These are limits, not reservations — net.ipv4.udp_mem still caps the total.',
    '#',
    '# NOTE: *_default is read at SOCKET CREATION, so a running NF keeps its old',
    '# buffers until it is restarted. Restarting open5gs-smfd/upfd drops every UE',
    '# session, so the NMS applies this file but never restarts an NF for it.',
    `net.core.rmem_default = ${GTPU_SOCKET_BUFFER_BYTES}`,
    `net.core.wmem_default = ${GTPU_SOCKET_BUFFER_BYTES}`,
    `net.core.rmem_max = ${GTPU_SOCKET_BUFFER_MAX_BYTES}`,
    `net.core.wmem_max = ${GTPU_SOCKET_BUFFER_MAX_BYTES}`,
    `net.core.netdev_max_backlog = ${NETDEV_MAX_BACKLOG}`,
  ].join('\n') + '\n';
}

export interface UndersizedSocket {
  /** Local address:port as ss printed it. */
  local: string;
  /** Owning process name, when ss reported one. */
  process: string | null;
  rmem: number;
  wmem: number;
}

/**
 * Finds GTP-U sockets still running on buffers smaller than `minBytes`.
 *
 * Parses `ss -uanpm` output, which prints each socket as a header line followed
 * by an indented `skmem:(r0,rb212992,t0,tb212992,...)` line — so a socket's
 * address and its buffer sizes are on DIFFERENT lines and have to be paired up.
 *
 * Scoped to port 2152 (GTP-U). A socket already at or above the target is not
 * reported, which is what makes the caller's "needs a restart" signal clear
 * itself once the operator has actually restarted the NFs.
 */
export function parseUndersizedGtpuSockets(ssOutput: string, minBytes: number): UndersizedSocket[] {
  const found: UndersizedSocket[] = [];
  const lines = (ssOutput ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    // ss columns: State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=..))]
    const local = header.match(/(\S+:2152)\s/);
    if (!local) continue;

    // skmem can be on this line or the next, depending on ss version/width.
    const skmem = /skmem:\(/.test(header) ? header : (lines[i + 1] ?? '');
    const rb = skmem.match(/\brb(\d+)/);
    const tb = skmem.match(/\btb(\d+)/);
    if (!rb || !tb) continue;

    const rmem = Number(rb[1]);
    const wmem = Number(tb[1]);
    if (rmem >= minBytes && wmem >= minBytes) continue;

    found.push({
      local: local[1],
      process: header.match(/users:\(\("([^"]+)"/)?.[1] ?? null,
      rmem,
      wmem,
    });
  }

  return found;
}

/**
 * `sysctl --system` applies /etc/sysctl.conf LAST, after every /etc/sysctl.d
 * drop-in, so a stray line there silently beats our file on the next boot. Report
 * it rather than editing a file we do not own.
 */
export function findOverridingSysctlConfLines(sysctlConfContent: string): string[] {
  return (sysctlConfContent ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .filter(l => /^net\.core\.(rmem|wmem)_(default|max)\s*=/.test(l));
}

export interface GtpuTuningResult {
  applied: boolean;
  /** Sockets still on the old buffers — non-empty means a one-time NF restart is pending. */
  undersized: UndersizedSocket[];
  /** Lines in /etc/sysctl.conf that would override the drop-in at next boot. */
  overrides: string[];
  error?: string;
}

/**
 * Writes and applies the GTP-U socket buffer drop-in, then reports whether the
 * already-running NFs still hold the old buffers.
 *
 * Idempotent, and safe to call on every backend start — writing the same content
 * and re-running `sysctl -p` changes nothing when it is already in place.
 *
 * Deliberately does NOT restart any NF. `*_default` is read at socket creation,
 * so the running UPF/SGW-U keep their old buffers until restarted — but
 * restarting open5gs-smfd/upfd tears down every PDU session AND leaves every UE
 * desynced from the AMF in a state that does not self-heal (the AMF keeps PDU
 * contexts the new SMF has never heard of, and UEs then loop
 * "PDU Session Reactivation Result : 0000" indefinitely). That is an operator's
 * decision to schedule, never a side effect of starting the NMS.
 */
export async function applyGtpuSocketBuffers(
  hostExecutor: IHostExecutor,
  logger: pino.Logger,
): Promise<GtpuTuningResult> {
  const result: GtpuTuningResult = { applied: false, undersized: [], overrides: [] };

  try {
    // /etc/sysctl.d/ is not bind-mounted into this container, so writeFile needs
    // the /proc/1/root host-path prefix. executeCommand does not — nsenter already
    // puts it in the host's own mount namespace. (Same split as auto-config.ts's
    // 99-open5gs-nat.conf.)
    await hostExecutor.writeFile(`/proc/1/root${GTPU_SYSCTL_PATH}`, gtpuSysctlContent());
    const applied = await hostExecutor.executeCommand('sysctl', ['-p', GTPU_SYSCTL_PATH]);
    if (applied.exitCode !== 0) {
      result.error = applied.stderr || `sysctl -p exited ${applied.exitCode}`;
      logger.warn({ path: GTPU_SYSCTL_PATH, err: result.error }, 'GTP-U buffer tuning: sysctl -p failed');
      return result;
    }
    result.applied = true;

    if (await hostExecutor.fileExists('/proc/1/root/etc/sysctl.conf')) {
      result.overrides = findOverridingSysctlConfLines(
        await hostExecutor.readFile('/proc/1/root/etc/sysctl.conf'),
      );
    }
    if (result.overrides.length > 0) {
      logger.warn(
        { overrides: result.overrides },
        'GTP-U buffer tuning: /etc/sysctl.conf sets net.core buffer values and is applied AFTER '
        + `${GTPU_SYSCTL_PATH} by "sysctl --system", so it will override this tuning on the next boot`,
      );
    }

    const ss = await hostExecutor.executeCommand('ss', ['-uanpm']);
    if (ss.exitCode === 0) {
      result.undersized = parseUndersizedGtpuSockets(ss.stdout, GTPU_SOCKET_BUFFER_BYTES);
    }

    if (result.undersized.length > 0) {
      logger.warn(
        { sockets: result.undersized, targetBytes: GTPU_SOCKET_BUFFER_BYTES },
        `GTP-U buffer tuning applied to ${GTPU_SYSCTL_PATH}, but ${result.undersized.length} already-running `
        + 'GTP-U socket(s) still hold the old buffers and will keep dropping packets under load. '
        + 'They pick up the new size only when their NF is restarted — which drops every UE session, '
        + 'so it is left for the operator to schedule rather than done here',
      );
    } else {
      logger.info({ path: GTPU_SYSCTL_PATH }, 'GTP-U socket buffer tuning applied; all GTP-U sockets at target size');
    }
  } catch (err) {
    result.error = String(err);
    logger.warn({ err: result.error }, 'GTP-U buffer tuning failed');
  }

  return result;
}

// ── UE TCP MSS clamping ─────────────────────────────────────────────────────
//
// The MTU the SMF advertises to a UE (smf.yaml `mtu`) only reaches handsets
// that actually REQUEST the IPv4 Link MTU PCO container. Open5GS includes it
// in the PCO response only when asked (src/smf/context.c), so a UE that does
// not ask uses 1500 on a path that cannot carry 1500, and every full-size
// segment is silently lost while small ones succeed — DNS resolves, TCP
// connects, pages never load.
//
// Clamping the MSS fixes that for TCP without depending on the UE honouring
// anything: the SYN's MSS option is rewritten in flight, so both ends
// negotiate a segment size that fits. It also removes the dependency on
// PMTUD, which needs an ICMP frag-needed to survive the GTP tunnel, the radio
// and whatever filters sit between — routinely it does not.
//
// Measured on this deployment 2026-11-06, which is why the numbers matter:
// the transit backhaul carries three radios over IPsec, and ESP tunnel mode
// with the live AES_CBC-256/HMAC_SHA2_256_128 SAs costs 62-77 bytes (outer IP
// 20 + ESP header 8 + IV 16 + padding/padlen/nexthdr 2-17 + ICV 16). On top of
// GTP-U's own 36 (IP 20 + UDP 8 + GTP 8), a 1400-byte UE packet reaches
// 1498-1513 on a 1500-byte path — it fits only with minimum padding, and
// fragments otherwise. The upstream path itself was verified at a full 1500,
// so the squeeze is entirely encapsulation, not an upstream constraint.
//
// NOT behind the NAT toggle, for the same reason ip_forward and the per-tun
// FORWARD accepts are not (see auto-config.ts): a routed deployment that
// advertises its UE pools over OSPF/EIGRP and NATs downstream on a core
// router needs this exactly as much as a masquerading one. This deployment IS
// that case, so gating it on NAT would mean it never applied here at all.

/** Marks our rules so a stale one can be found and replaced when the MTU changes. */
export const MSS_RULE_COMMENT = 'open5gs-nms-mss';

/** Open5GS's own default when smf.yaml sets no `mtu`. */
export const DEFAULT_UE_MTU = 1400;

/**
 * TCP MSS for a UE link MTU: MTU minus the IP and TCP headers.
 *
 * IPv4 is 20 + 20, IPv6 is 40 + 20. This is the inner header cost only — the
 * GTP-U and ESP overhead above is already accounted for by the UE MTU being
 * below the path MTU, so subtracting it again would clamp twice.
 */
export function mssForMtu(mtu: number, family: 4 | 6 = 4): number {
  return mtu - (family === 4 ? 40 : 60);
}

/**
 * iptables arguments for one direction of the clamp.
 *
 * Both directions are needed and they do different jobs: `-i dev` rewrites the
 * UE's own SYN so the remote server sends small enough segments, and `-o dev`
 * rewrites the server's SYN-ACK so the UE does. Clamping only one leaves the
 * other half of every connection at full size.
 */
export function mssRuleArgs(
  op: '-C' | '-A' | '-D',
  dev: string,
  direction: 'in' | 'out',
  mss: number,
): string[] {
  return [
    '-t', 'mangle', op, 'FORWARD',
    direction === 'in' ? '-i' : '-o', dev,
    '-p', 'tcp', '--tcp-flags', 'SYN,RST', 'SYN',
    '-m', 'comment', '--comment', MSS_RULE_COMMENT,
    '-j', 'TCPMSS', '--set-mss', String(mss),
  ];
}

/**
 * Finds our clamp rules on `dev` whose MSS is not `desiredMss`, as `-D` argument
 * arrays ready to execute.
 *
 * This exists because the idempotent "-C then -A" pattern used everywhere else
 * in auto-config.ts is NOT sufficient here. Those rules are fully described by
 * their match, so re-adding is a no-op. A clamp rule carries a VALUE: lower the
 * MTU from 1400 to 1380 and `-C` reports the 1340 rule missing, `-A` appends it,
 * and the 1360 rule from before is still sitting ahead of it in the chain —
 * where it wins, because the first TCPMSS to rewrite the option is the one that
 * takes effect. The operator would see the new MTU in the UI, a correct-looking
 * rule in the table, and the old clamp still applied to every connection.
 *
 * Parses `iptables -t mangle -S FORWARD`, matching on our own comment so an
 * operator's hand-written TCPMSS rule is left alone.
 */
export function findStaleMssRules(
  savedForward: string,
  dev: string,
  desiredMss: number,
): string[][] {
  const stale: string[][] = [];

  for (const line of (savedForward ?? '').split('\n')) {
    if (!line.includes(`--comment ${MSS_RULE_COMMENT}`)) continue;

    // Direction, taken from the rule itself rather than assumed, so a rule
    // whose direction we no longer generate is still cleaned up.
    const inMatch = new RegExp(`-i ${dev}(\\s|$)`).test(line);
    const outMatch = new RegExp(`-o ${dev}(\\s|$)`).test(line);
    if (!inMatch && !outMatch) continue;

    const mss = Number(line.match(/--set-mss (\d+)/)?.[1]);
    if (Number.isFinite(mss) && mss === desiredMss) continue; // already correct

    stale.push(mssRuleArgs('-D', dev, inMatch ? 'in' : 'out', mss));
  }

  return stale;
}

export interface MssClampResult {
  /** MSS actually applied, derived from the UE MTU. */
  mss: number;
  /** Devices a rule is now in place for. */
  devs: string[];
  /** Rules removed because they carried a different MSS. */
  replaced: number;
  error?: string;
}

/**
 * Applies the TCP MSS clamp for every UE tun device.
 *
 * Idempotent: an already-correct rule is detected with `-C` and left alone, so
 * re-running Apply Config never duplicates. A rule carrying a different MSS is
 * deleted first (see findStaleMssRules) rather than left to shadow the new one.
 *
 * Persistence is the caller's: auto-config.ts runs `netfilter-persistent save`
 * after this, in the same block that saves the FORWARD accepts.
 *
 * IPv6 is applied too, for symmetry with the NAT block's own two-family
 * handling. Note it is UNEXERCISED on this deployment — smf.yaml declares a
 * 2001:db8:cafe::/48 pool but neither tun device carries a global IPv6
 * address, so no UE traffic reaches these rules here. A failure on the v6 half
 * is logged and tolerated rather than failing the v4 clamp that is actually
 * carrying traffic.
 */
export async function applyUeMssClamp(
  hostExecutor: IHostExecutor,
  devs: string[],
  ueMtu: number,
  logger: pino.Logger,
): Promise<MssClampResult> {
  const mss = mssForMtu(ueMtu, 4);
  const result: MssClampResult = { mss, devs: [], replaced: 0 };

  try {
    const saved = await hostExecutor.executeCommand('iptables', ['-t', 'mangle', '-S', 'FORWARD']);
    const savedForward = saved.exitCode === 0 ? saved.stdout : '';

    for (const dev of devs) {
      for (const args of findStaleMssRules(savedForward, dev, mss)) {
        await hostExecutor.executeCommand('iptables', args);
        result.replaced++;
      }

      for (const direction of ['in', 'out'] as const) {
        const check = await hostExecutor.executeCommand('iptables', mssRuleArgs('-C', dev, direction, mss));
        if (check.exitCode !== 0) {
          await hostExecutor.executeCommand('iptables', mssRuleArgs('-A', dev, direction, mss));
        }
      }

      // Best-effort v6 — see the note above on why this is unexercised here.
      const mss6 = mssForMtu(ueMtu, 6);
      for (const direction of ['in', 'out'] as const) {
        try {
          const c6 = await hostExecutor.executeCommand('ip6tables', mssRuleArgs('-C', dev, direction, mss6));
          if (c6.exitCode !== 0) {
            await hostExecutor.executeCommand('ip6tables', mssRuleArgs('-A', dev, direction, mss6));
          }
        } catch {
          // ip6tables missing or mangle unavailable — v4 is what carries traffic.
        }
      }

      result.devs.push(dev);
    }

    logger.info(
      { mss, ueMtu, devs: result.devs, replaced: result.replaced },
      `UE TCP MSS clamp applied (MSS ${mss} from UE MTU ${ueMtu})`
      + (result.replaced > 0 ? `, replaced ${result.replaced} stale rule(s)` : ''),
    );
  } catch (err) {
    result.error = String(err);
    logger.warn({ err: result.error }, 'UE TCP MSS clamp failed');
  }

  return result;
}

// ── UE pool source NAT (MASQUERADE) ─────────────────────────────────────────
//
// Host-based NAT is the alternative to advertising the UE pools into the
// routing protocol: either the upstream router has a route back to 10.45.0.0/24
// (FRR's `network` statement, see frr-controller.ts's ue-subnets endpoints), or
// this host rewrites the source so no such route is needed. They are mutually
// exclusive by intent, and picking neither leaves UE traffic with no return
// path at all.
//
// The rule shape is `-s <pool> ! -o <pool's own tun dev> -j MASQUERADE`, which
// is the Open5GS-documented idiom and is already used verbatim by
// gsm-controller.ts (the GGSN pool) and ims-controller.ts (ogstun2). Excluding
// the pool's own device is what keeps UE-to-UE traffic inside the same tunnel
// untranslated. Traffic to an address that is local to this host — every IMS NF
// lives on a dummy interface here — never reaches POSTROUTING at all, so IMS
// signalling is not affected by the IMS pool having a rule.
//
// This planner exists because the call site used to pick subnets BY ARRAY
// INDEX: pool[0] was assumed IPv4 and pool[1] IPv6. A deployment with two IPv4
// pools (this one: 10.45.0.0/24 internet + 10.46.0.0/24 ims) therefore handed
// an IPv4 CIDR to `ip6tables`, which rejects it — and because the executor
// returns a non-zero exit code rather than throwing, the IMS pool silently got
// no NAT rule and nothing was logged. Family is a property of the subnet, and
// the device is a property of the pool; neither is a property of its position.

/** A session pool as far as NAT is concerned — the subnet and its tun device. */
export interface UeNatPool {
  subnet: string;
  dev?: string;
}

export interface UeNatRule {
  /** Chosen from the subnet itself, never from the pool's position in the list. */
  bin: 'iptables' | 'ip6tables';
  family: 4 | 6;
  subnet: string;
  /** The pool's own tunnel device, excluded from translation. */
  dev: string;
}

/**
 * One MASQUERADE rule per session pool, de-duplicated. Pools with no subnet are
 * dropped rather than turned into a rule matching everything.
 */
export function planUeNatRules(pools: UeNatPool[], fallbackDev = 'ogstun'): UeNatRule[] {
  const rules: UeNatRule[] = [];
  const seen = new Set<string>();

  for (const pool of pools ?? []) {
    const subnet = (pool?.subnet ?? '').trim();
    if (!subnet) continue;

    const family: 4 | 6 = subnet.includes(':') ? 6 : 4;
    const dev = (pool.dev || '').trim() || fallbackDev;
    const key = `${family}|${subnet}|${dev}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rules.push({ bin: family === 6 ? 'ip6tables' : 'iptables', family, subnet, dev });
  }

  return rules;
}

/** iptables arguments for one planned rule. `-C` checks, `-A` adds, `-D` removes. */
export function ueNatRuleArgs(op: '-C' | '-A' | '-D', rule: UeNatRule): string[] {
  return [
    '-t', 'nat', op, 'POSTROUTING',
    '-s', rule.subnet,
    '!', '-o', rule.dev,
    '-j', 'MASQUERADE',
  ];
}

// ── UE data-plane queue and CPU tuning ──────────────────────────────────────
//
// Measured on this deployment 2026-11-07, which is why these three exist:
//
//  * 25,651 downlink packets (0.34% of 7.6M) were dropped at ogstun's TX queue
//    — the KERNEL unable to hand packets to upfd, not a link problem. The tun
//    default txqueuelen is 500 packets, well under a second of burst at any
//    5G rate, so a burst above upfd's drain rate starts dropping immediately.
//  * All ens20 (N3) receive processing lands on ONE core (1.39M interrupts on
//    cpu2) because virtio reports `Combined: 1` and rps_cpus was 0 on every
//    device, so nothing spread it.
//  * upfd's forwarding is a SINGLE thread (verified: of its two threads, one
//    is the signal handler at 0.14s CPU and the other had burned 723.75s), so
//    it shares whatever core it lands on with that NIC softirq by luck alone.
//
// What this does NOT do is make the UPF use more cores. It cannot: Open5GS
// v2.8.0's UPF has one forwarding thread and no thread/worker/affinity config
// key anywhere in the binary, and its affinity is already unrestricted (0-7).
// A single thread runs on one core at a time. The only way to spread the data
// plane across cores is more upfd PROCESSES — smf.yaml's `client.upf` is a
// list, so a second UPF on its own loopback can take a different DNN.
//
// So the aim here is narrower and achievable: stop the one forwarding thread
// from competing with NIC softirq, and give it a queue deep enough to absorb
// a burst.

/** 500 (the tun default) is under a second of burst; 10000 is ~14MB at 1380B. */
export const UE_TUN_TXQUEUELEN = 10000;
/** Modest priority bump. Not realtime: a runaway RT dataplane can wedge a box. */
export const UPF_NICE = -10;
export const UE_TUN_UDEV_RULE = '/etc/udev/rules.d/99-open5gs-ue-tun.rules';
export const UPF_CPU_DROPIN_DIR = '/etc/systemd/system/open5gs-upfd.service.d';
export const UPF_CPU_DROPIN = `${UPF_CPU_DROPIN_DIR}/10-nms-cpu.conf`;

export const nfCpuDropInDir = (unit: string) => `/etc/systemd/system/${unit}.service.d`;
export const nfCpuDropIn = (unit: string) => `${nfCpuDropInDir(unit)}/10-nms-cpu.conf`;

/**
 * The user-plane forwarders, heaviest first.
 *
 * Both are single-threaded (measured: of each one's two threads, the signal
 * handler had 0.14 s of CPU and one worker had everything — upfd 815 s,
 * sgwud 471 s). A 4G downlink traverses BOTH on this host — eNB -> sgwud ->
 * `lo` -> upfd -> internet, since the S5-U endpoints are two local /32s and
 * `ip route get` resolves them `dev lo`. So 4G pays the userspace cost twice,
 * on two different threads, and if those threads share a CPU the two hops
 * SERIALISE instead of pipelining. Order matters: the heavier process is
 * given the first (larger) share.
 */
export const USER_PLANE_UNITS: string[] = ['open5gs-upfd', 'open5gs-sgwud'];

/** Parse a Linux CPU list — "2", "0-3,5", "0-1,4-5" — into explicit CPU ids. */
export function parseCpuList(spec: string): number[] {
  const out = new Set<number>();
  for (const part of (spec ?? '').trim().split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const range = /^(\d+)-(\d+)$/.exec(seg);
    if (range) {
      const lo = Number(range[1]), hi = Number(range[2]);
      // Guard against a reversed or absurd range rather than looping forever.
      if (hi < lo || hi - lo > 4096) continue;
      for (let i = lo; i <= hi; i++) out.add(i);
    } else if (/^\d+$/.test(seg)) {
      out.add(Number(seg));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Hex mask in the format sysfs rps_cpus expects: comma-separated 32-bit words,
 * most-significant first. A single word is NOT good enough above 32 CPUs, and
 * writing an over-long single word is rejected outright.
 */
export function cpuMaskHex(cpus: number[], totalCpus: number): string {
  const words = Math.max(1, Math.ceil(totalCpus / 32));
  const acc = new Array<number>(words).fill(0);
  for (const c of cpus) {
    if (c < 0 || c >= words * 32) continue;
    const w = words - 1 - Math.floor(c / 32);
    acc[w] = (acc[w] | (1 << (c % 32))) >>> 0;
  }
  return acc.map(w => (w >>> 0).toString(16)).join(',');
}

/**
 * CPUs that ACTUALLY serve the given IRQs, by share of delivered interrupts.
 *
 * Deliberately not read from /proc/irq/N/smp_affinity_list. On this deployment
 * every NIC IRQ lists `0-7`, i.e. the kernel is *allowed* to deliver anywhere —
 * but each single-queue virtio vector in practice lands on exactly one CPU and
 * stays there (measured: ens20 input on cpu1 with 110M interrupts, output on
 * cpu2 with 95M; ens18 input on cpu3, output on cpu4). Excluding the permitted
 * set would exclude every core and achieve nothing; excluding where interrupts
 * actually land is the thing that helps.
 */
export function irqHotCpus(procInterrupts: string, irqs: string[], minShare = 0.05): number[] {
  const lines = (procInterrupts ?? '').split('\n');
  if (lines.length === 0) return [];
  const nCpu = (lines[0].match(/CPU\d+/g) ?? []).length;
  if (nCpu === 0) return [];

  const want = new Set(irqs.map(String));
  const perCpu = new Array<number>(nCpu).fill(0);
  let total = 0;

  for (const line of lines.slice(1)) {
    const m = /^\s*(\d+):\s+(.*)$/.exec(line);
    if (!m || !want.has(m[1])) continue;
    const fields = m[2].trim().split(/\s+/);
    for (let c = 0; c < nCpu && c < fields.length; c++) {
      const v = Number(fields[c]);
      if (!Number.isFinite(v)) break;   // reached the descriptive columns
      perCpu[c] += v;
      total += v;
    }
  }

  if (total === 0) return [];
  const out: number[] = [];
  for (let c = 0; c < nCpu; c++) {
    if (perCpu[c] > 0 && perCpu[c] / total >= minShare) out.push(c);
  }
  return out;
}

/** CPUs 0..total-1 with `exclude` removed. */
export function cpusExcluding(total: number, exclude: number[]): number[] {
  const bad = new Set(exclude);
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!bad.has(i)) out.push(i);
  return out;
}

/** Collapse explicit CPU ids back into a list taskset/systemd accept. */
export function formatCpuList(cpus: number[]): string {
  const s = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/**
 * Partition CPUs into `n` DISJOINT groups, earlier groups getting the
 * remainder when the split is uneven.
 *
 * Disjoint rather than shared on purpose. Two single-threaded processes
 * sharing one affinity mask can be scheduled onto the same CPU, which is
 * exactly the 4G serialisation this exists to prevent; and since each uses
 * only one CPU at a time, narrowing each one's set costs nothing. Returns
 * fewer groups than asked when there are not enough CPUs to go round, so a
 * caller never silently gets an empty mask (which `taskset` rejects anyway).
 */
export function splitCpuSets(cpus: number[], n: number): number[][] {
  const src = [...new Set(cpus)].sort((a, b) => a - b);
  if (n <= 0 || src.length === 0) return [];
  if (src.length < n) return src.map(c => [c]);

  const base = Math.floor(src.length / n);
  const extra = src.length % n;
  const out: number[][] = [];
  let i = 0;
  for (let g = 0; g < n; g++) {
    const take = base + (g < extra ? 1 : 0);
    out.push(src.slice(i, i + take));
    i += take;
  }
  return out;
}

export function ueTunUdevRuleContent(devs: string[], txQueueLen: number, rpsMask: string): string {
  // udev, not a one-shot `ip link set`, because ogstun is created by upfd and
  // every upfd restart makes a fresh device with default attributes — a live
  // apply alone silently lapses the next time the UPF restarts.
  const lines = [
    '# Open5GS UE tunnel queue/steering — written by NMS host-tuning.',
    '# ogstun is recreated by upfd on every restart, so these have to be',
    '# re-asserted by udev rather than set once.',
  ];
  for (const dev of devs) {
    lines.push(
      `ACTION=="add", SUBSYSTEM=="net", KERNEL=="${dev}", ATTR{tx_queue_len}="${txQueueLen}"`,
      `ACTION=="add", SUBSYSTEM=="net", KERNEL=="${dev}", ATTR{queues/rx-0/rps_cpus}="${rpsMask}"`,
    );
  }
  return lines.join('\n') + '\n';
}

export function nfCpuDropInContent(unit: string, cpuList: string, nice: number): string {
  return [
    `# ${unit} CPU placement — written by NMS host-tuning.`,
    '# Keeps this single-threaded forwarding thread off the cores serving NIC',
    '# interrupts, AND off the cores given to the other user-plane process.',
    '#',
    '# The second part matters for 4G specifically: a 4G downlink crosses BOTH',
    '# sgwud and upfd on this host (the S5-U endpoints are two local /32s, so',
    '# the hop resolves `dev lo`), and if the two single threads land on the',
    '# same CPU those hops serialise instead of pipelining.',
    '#',
    '# Each set is still more than one CPU, so the scheduler keeps a choice —',
    '# hard-pinning a process that may gain threads later is worse.',
    '[Service]',
    `CPUAffinity=${cpuList}`,
    `Nice=${nice}`,
    '',
  ].join('\n');
}

/** Back-compat wrapper: the UPF's own drop-in. */
export function upfCpuDropInContent(cpuList: string, nice: number): string {
  return nfCpuDropInContent('open5gs-upfd', cpuList, nice);
}

export interface DataPlaneTuningResult {
  txQueueLen: Array<{ dev: string; before: number | null; after: number }>;
  rps: { mask: string; devs: string[] } | null;
  /** Devices left alone because hardware multiqueue already spreads them. */
  rpsSkipped: Array<{ dev: string; rxQueues: number }>;
  upf: { cpuList: string; nice: number; live: boolean } | null;
  /** Per-user-plane-unit CPU placement. Disjoint sets, heaviest unit first. */
  userPlaneCpus: Array<{ unit: string; cpuList: string; nice: number; live: boolean }>;
  nicCpus: number[];
  nicIfaces: string[];
  totalCpus: number;
  skipped?: string;
  error?: string;
}

export async function applyUeDataPlaneTuning(
  hostExecutor: IHostExecutor,
  devs: string[],
  logger: pino.Logger,
): Promise<DataPlaneTuningResult> {
  const result: DataPlaneTuningResult = {
    txQueueLen: [], rps: null, rpsSkipped: [], upf: null, userPlaneCpus: [],
    nicCpus: [], nicIfaces: [], totalCpus: 0,
  };

  const read = async (path: string): Promise<string | null> => {
    // Every caller treats null as "not present on this host" and carries on,
    // so a miss is an expected outcome rather than an error.
    const r = await hostExecutor.executeCommand('cat', [path], undefined, { expectedFailure: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };

  try {
    const nproc = await hostExecutor.executeCommand('nproc', []);
    const totalCpus = Number(nproc.stdout.trim()) || 1;
    result.totalCpus = totalCpus;

    // ── Which CPUs serve NIC interrupts ────────────────────────────────────
    // Resolved through /sys rather than by matching /proc/interrupts names: the
    // IRQ there is called "virtio0-virtqueues", which cannot be mapped back to
    // "ens20" by name at all.
    const nicCpus = new Set<number>();
    const nicIfaces: string[] = [];
    const allNicIrqs: string[] = [];
    const procInterrupts = (await read('/proc/interrupts')) ?? '';
    const links = await hostExecutor.executeCommand('ls', ['/sys/class/net']);
    for (const iface of links.stdout.split(/\s+/).filter(Boolean)) {
      if (/^(lo|ogstun|apn-|dummy-|docker|veth|br-|virbr)/.test(iface)) continue;

      // msi_irqs sits on the PCI device. For a plain NIC that IS
      // /sys/class/net/<if>/device, but for virtio-net that symlink points at
      // the virtio bus device and the vectors live on its PCI PARENT — which
      // is why looking only at the first path found nothing here and left the
      // mask as "all CPUs", silently doing nothing at all.
      // expectedFailure: a virtual interface (vc-xfrm0, a bridge, a tun) has no
      // `device` symlink at all, which is normal and not worth an error line.
      const resolved = await hostExecutor.executeCommand(
        'readlink', ['-f', `/sys/class/net/${iface}/device`], undefined, { expectedFailure: true });
      if (resolved.exitCode !== 0) continue;
      const devDir = resolved.stdout.trim();
      const parentDir = devDir.slice(0, Math.max(0, devDir.lastIndexOf('/')));

      let irqs: string[] = [];
      for (const dir of [devDir, parentDir]) {
        if (!dir) continue;
        // expectedFailure: this loop deliberately probes two locations because
        // virtio keeps its vectors on the PCI PARENT, so the first miss is the
        // normal path, not a fault. Without this the backend logged 5
        // error-level lines on every start for a pass that fully succeeded.
        const ls = await hostExecutor.executeCommand(
          'ls', [`${dir}/msi_irqs`], undefined, { expectedFailure: true });
        if (ls.exitCode === 0) {
          irqs = ls.stdout.split(/\s+/).filter(Boolean);
          break;
        }
      }
      if (irqs.length === 0) continue;

      nicIfaces.push(iface);
      allNicIrqs.push(...irqs);
    }

    // Share is judged against TOTAL NIC interrupt load, not per interface.
    // Measured why: ens19 is an idle service-plane link whose single output
    // vector had taken 830 interrupts, all on cpu7. Per-interface that is a
    // 100% share, so cpu7 was excluded and the forwarding thread lost a core
    // to a link carrying nothing. Against the ~355M total it is 0.0002% and
    // correctly ignored, while every genuinely busy vector stays well clear
    // of the threshold.
    for (const c of irqHotCpus(procInterrupts, allNicIrqs, 0.02)) nicCpus.add(c);
    result.nicCpus = [...nicCpus].sort((a, b) => a - b);
    result.nicIfaces = nicIfaces;

    // ── 1. Tun transmit queue depth ────────────────────────────────────────
    for (const dev of devs) {
      const before = await read(`/sys/class/net/${dev}/tx_queue_len`);
      const cur = before === null ? null : Number(before);
      if (cur !== null && cur >= UE_TUN_TXQUEUELEN) {
        result.txQueueLen.push({ dev, before: cur, after: cur });
        continue;
      }
      const set = await hostExecutor.executeCommand(
        'ip', ['link', 'set', 'dev', dev, 'txqueuelen', String(UE_TUN_TXQUEUELEN)]);
      if (set.exitCode === 0) {
        result.txQueueLen.push({ dev, before: cur, after: UE_TUN_TXQUEUELEN });
      }
    }

    // A box with few cores has nothing to steer to, and excluding NIC cores
    // there would leave the dataplane on one shared core anyway.
    const candidates = cpusExcluding(totalCpus, result.nicCpus);
    if (totalCpus < 4 || candidates.length < 2) {
      result.skipped = `only ${totalCpus} CPU(s) with ${candidates.length} free of NIC IRQs — `
        + 'queue depth applied, CPU steering skipped';
      logger.info({ totalCpus, nicCpus: result.nicCpus }, 'Skipped UE data-plane CPU steering');
      return result;
    }

    const mask = cpuMaskHex(candidates, totalCpus);
    // The mask is generated above, but it is interpolated into a shell
    // redirect (sysfs cannot be written via writeFile, which does
    // temp-file + rename). Validate the shape anyway rather than trusting
    // our own caller chain.
    if (!/^[0-9a-f]+(,[0-9a-f]+)*$/.test(mask)) {
      result.error = `refusing to write a malformed rps mask: ${mask}`;
      logger.warn({ mask }, result.error);
      return result;
    }

    // ── 2. Receive packet steering, so RX is not stuck on the IRQ core ─────
    //
    // Applied to the physical NICs as well as the tunnels, because the NICs are
    // where the single queue actually is. On this deployment (a Proxmox guest)
    // `ethtool -l` reports Pre-set maximum Combined: 1, so hardware multiqueue
    // is not merely unused — it is unavailable to the guest until the VM's
    // virtio device is recreated with queues=N on the hypervisor. RPS is the
    // only in-guest way to get receive processing onto more than one core, and
    // is therefore the mitigation rather than a nicety.
    const rpsDevs: string[] = [];
    for (const dev of [...devs, ...nicIfaces]) {
      const queues = await hostExecutor.executeCommand(
        'ls', [`/sys/class/net/${dev}/queues`], undefined, { expectedFailure: true });
      if (queues.exitCode !== 0) continue;
      const rxQueues = queues.stdout.split(/\s+/).filter(n => n.startsWith('rx-'));

      // RPS exists to spread receive processing when the HARDWARE cannot. A
      // device with several rx queues is already being spread by RSS across
      // whatever cores its IRQs land on, and writing this narrow mask to every
      // one of those queues would funnel them all back onto a handful of cores
      // — actively undoing hardware multiqueue and costing throughput on
      // better hardware than this deployment's.
      //
      // Only the single-queue case benefits, which is what this host has
      // (virtio reporting Pre-set maximum Combined: 1) but is NOT what a
      // bare-metal NIC looks like. Guarded rather than assumed, because the
      // failure mode is a silent regression on a host nobody is watching.
      if (rxQueues.length !== 1) {
        result.rpsSkipped.push({ dev, rxQueues: rxQueues.length });
        continue;
      }

      for (const q of rxQueues) {
        const w = await hostExecutor.executeCommand(
          'bash', ['-c', `echo ${mask} > /sys/class/net/${dev}/queues/${q}/rps_cpus`]);
        if (w.exitCode === 0 && !rpsDevs.includes(dev)) rpsDevs.push(dev);
      }
    }
    result.rps = { mask, devs: rpsDevs };

    // ── 3. Keep each forwarder off the NIC IRQ cores AND off each other ────
    //
    // One disjoint share per user-plane unit. With a single share they could
    // be scheduled onto the same CPU, which is precisely the 4G serialisation
    // problem: that path crosses sgwud AND upfd on this host.
    const shares = splitCpuSets(candidates, USER_PLANE_UNITS.length);
    for (let i = 0; i < USER_PLANE_UNITS.length && i < shares.length; i++) {
      const unit = USER_PLANE_UNITS[i];
      const unitCpus = formatCpuList(shares[i]);
      let unitLive = false;

      const pid = await hostExecutor.executeCommand(
        'pgrep', ['-x', unit], undefined, { expectedFailure: true });
      const unitPid = pid.stdout.trim().split('\n')[0];
      if (pid.exitCode === 0 && /^\d+$/.test(unitPid)) {
        const t = await hostExecutor.executeCommand('taskset', ['-pc', unitCpus, unitPid]);
        const n = await hostExecutor.executeCommand('renice', ['-n', String(UPF_NICE), '-p', unitPid]);
        unitLive = t.exitCode === 0 && n.exitCode === 0;
      }

      // Persisted for the next restart. Deliberately NOT followed by a restart:
      // restarting either forwarder desynchronises every established session
      // and does not self-heal (see the GTP-U socket buffer notes above).
      await hostExecutor.executeCommand('mkdir', ['-p', nfCpuDropInDir(unit)]);
      await hostExecutor.writeFile(
        `/proc/1/root${nfCpuDropIn(unit)}`, nfCpuDropInContent(unit, unitCpus, UPF_NICE));

      result.userPlaneCpus.push({ unit, cpuList: unitCpus, nice: UPF_NICE, live: unitLive });
      // Back-compat: callers and dashboards still read `.upf`.
      if (unit === 'open5gs-upfd') result.upf = { cpuList: unitCpus, nice: UPF_NICE, live: unitLive };
    }
    await hostExecutor.executeCommand('systemctl', ['daemon-reload']);

    // ── Persist the tun attributes across a upfd restart ───────────────────
    await hostExecutor.writeFile(
      `/proc/1/root${UE_TUN_UDEV_RULE}`, ueTunUdevRuleContent(devs, UE_TUN_TXQUEUELEN, mask));
    await hostExecutor.executeCommand('udevadm', ['control', '--reload-rules']);

    logger.info(
      {
        devs, totalCpus, nicCpus: result.nicCpus, mask, rpsDevs,
        rpsSkipped: result.rpsSkipped,
        userPlaneCpus: result.userPlaneCpus.map(u => `${u.unit}:${u.cpuList}${u.live ? '' : '(not live)'}`),
      },
      'Applied UE data-plane queue and CPU tuning',
    );
  } catch (err) {
    result.error = String(err);
    logger.warn({ err: result.error }, 'UE data-plane tuning failed');
  }

  return result;
}

// ── NF memory policy: keep the user plane out of swap ───────────────────────
//
// Measured on this deployment before this was applied: open5gs-upfd held MORE
// memory in swap (24,096 kB) than resident (20,956 kB), and sgwud/sgwcd were
// ~66-68% swapped out — while the hypervisor sat on 14.3 GB of RAM it had
// never touched and had never used its own swap.
//
// This matters far more for a mobile core than for a general-purpose host,
// because the Open5GS user plane forwards on a SINGLE thread. A major fault on
// a cold session-table page stalls the whole data plane for an SSD round trip,
// where on a thread-per-connection server it would merely delay one worker out
// of many. The same argument is why the GTP-U buffers above are a sysctl: the
// forwarding loop must never block on something avoidable.

export const DATAPLANE_MEMORY_SYSCTL_PATH =
  '/etc/sysctl.d/99-open5gs-dataplane-memory.conf';

/** 10 rather than 0 — swap stays available as a genuine last resort. */
export const DATAPLANE_SWAPPINESS = 10;

/**
 * Units forbidden from swapping at all.
 *
 * Deliberately not every `open5gs-*` unit. These six either forward user
 * traffic or run the session/mobility state machines that a forwarding path
 * waits on. The ones left out (nrfd, udrd, udmd, ausfd, seppd, ...) are
 * request/response services where a fault costs latency on one transaction
 * instead of stalling a packet pipeline.
 */
export const NO_SWAP_UNITS: string[] = [
  'open5gs-upfd', 'open5gs-sgwud',  // user plane
  'open5gs-smfd', 'open5gs-sgwcd',  // session management
  'open5gs-amfd', 'open5gs-mmed',   // mobility / NAS
];

export const nfMemoryDropInDir = (unit: string) => `/etc/systemd/system/${unit}.service.d`;
export const nfMemoryDropIn = (unit: string) => `${nfMemoryDropInDir(unit)}/10-nms-memory.conf`;

export function dataplaneMemorySysctlContent(): string {
  return [
    '# Open5GS data-plane memory policy \u2014 written by open5gs-nms (host-tuning.ts).',
    '#',
    '# The stock vm.swappiness=60 had paged out more than half of the UPF:',
    '# open5gs-upfd held 24,096 kB in swap against 20,956 kB resident, and',
    '# open5gs-sgwud/sgwcd were ~66-68% swapped. That matters far more here than',
    '# on a general-purpose host, because the Open5GS UPF forwards on a SINGLE',
    '# thread \u2014 one major fault on a cold session-table page stalls the entire',
    '# data plane for an SSD round trip, not just one worker.',
    '#',
    `# ${DATAPLANE_SWAPPINESS} (not 0) keeps swap available as a genuine last resort while making the`,
    '# kernel strongly prefer reclaiming page cache over anonymous memory.',
    '#',
    '# Belt and braces: the traffic-carrying NFs also get MemorySwapMax=0 in their',
    '# systemd drop-ins, which forbids swap for those cgroups outright regardless',
    '# of this global value.',
    `vm.swappiness = ${DATAPLANE_SWAPPINESS}`,
    '',
  ].join('\n');
}

export function nfMemoryDropInContent(): string {
  return [
    '# Open5GS NF memory policy \u2014 written by NMS host-tuning.',
    '#',
    '# Forbids this cgroup from using swap at all. The Open5GS user plane forwards',
    '# on a single thread, so a major fault on a swapped-out page stalls the whole',
    '# data plane for an SSD round trip rather than just delaying one worker of',
    '# many. Measured before this was set: upfd held more memory in swap (24,096 kB)',
    '# than resident (20,956 kB); sgwud and sgwcd were ~66-68% swapped out.',
    '#',
    '# No MemoryMax is set on these units, so refusing swap cannot turn into a',
    '# cgroup OOM kill \u2014 the kernel simply reclaims page cache elsewhere instead.',
    `# vm.swappiness=${DATAPLANE_SWAPPINESS} in ${DATAPLANE_MEMORY_SYSCTL_PATH} is the`,
    '# global half of this; this file is the per-NF guarantee.',
    '[Service]',
    'MemorySwapMax=0',
    '',
  ].join('\n');
}

export interface NfMemoryPolicyResult {
  swappiness: { before: number | null; after: number | null };
  units: Array<{ unit: string; swapMax: string | null }>;
  /** Swap still in use host-wide, KB. Policy stops growth; it cannot un-swap. */
  stillSwappedKb: number;
  /** Set when pages are still parked in swap and an operator action is needed. */
  reclaimHint?: string;
  error?: string;
}

/**
 * Applies the swap policy and reports what is still swapped.
 *
 * Deliberately does NOT run `swapoff -a && swapon -a`. MemorySwapMax only
 * prevents further swap-OUT; pages already parked in swap stay there until
 * faulted in, and the only non-disruptive way to reclaim them in bulk is a
 * swap cycle — which took 90 s and ~2 GB of read I/O on this host. That is a
 * one-time operator action, not something to repeat on every backend start or
 * Apply Config, so it is surfaced as a hint instead of performed. (The
 * disruptive alternative — restarting upfd — desynchronises every established
 * PDU session and does not self-heal.)
 */
export async function applyNfMemoryPolicy(
  hostExecutor: IHostExecutor,
  logger: pino.Logger,
): Promise<NfMemoryPolicyResult> {
  const result: NfMemoryPolicyResult = {
    swappiness: { before: null, after: null }, units: [], stillSwappedKb: 0,
  };

  const readNum = async (args: string[]): Promise<number | null> => {
    const r = await hostExecutor.executeCommand('sysctl', args);
    const n = Number(r.stdout.trim());
    return r.exitCode === 0 && Number.isFinite(n) ? n : null;
  };

  try {
    result.swappiness.before = await readNum(['-n', 'vm.swappiness']);

    // /etc/sysctl.d/ is not bind-mounted into this container, so the write has
    // to go through the host's root — same reason as the GTP-U buffers above.
    await hostExecutor.writeFile(
      `/proc/1/root${DATAPLANE_MEMORY_SYSCTL_PATH}`, dataplaneMemorySysctlContent());
    const applied = await hostExecutor.executeCommand(
      'sysctl', ['-p', DATAPLANE_MEMORY_SYSCTL_PATH]);
    if (applied.exitCode !== 0) {
      result.error = applied.stderr || `sysctl -p exited ${applied.exitCode}`;
      logger.warn({ path: DATAPLANE_MEMORY_SYSCTL_PATH, err: result.error },
        'NF memory policy: sysctl -p failed');
    }
    result.swappiness.after = await readNum(['-n', 'vm.swappiness']);

    for (const unit of NO_SWAP_UNITS) {
      await hostExecutor.executeCommand('mkdir', ['-p', nfMemoryDropInDir(unit)]);
      await hostExecutor.writeFile(`/proc/1/root${nfMemoryDropIn(unit)}`, nfMemoryDropInContent());
    }
    // daemon-reload re-applies cgroup properties to already-RUNNING units, so
    // this takes effect without restarting an NF (verified live: every
    // memory.swap.max went to 0 with ActiveEnterTimestamp unchanged).
    await hostExecutor.executeCommand('systemctl', ['daemon-reload']);

    for (const unit of NO_SWAP_UNITS) {
      // Read the kernel's view, not systemd's: `systemctl show` would echo
      // back the drop-in we just wrote whether or not it ever reached a cgroup.
      // expectedFailure: the cgroup directory does not exist while a unit is
      // stopped, which is a legitimate state (an optional NF, or 4G-only /
      // 5G-only deployments) and is reported as null rather than an error.
      const cg = await hostExecutor.executeCommand(
        'cat', [`/sys/fs/cgroup/system.slice/${unit}.service/memory.swap.max`],
        undefined, { expectedFailure: true });
      result.units.push({ unit, swapMax: cg.exitCode === 0 ? cg.stdout.trim() : null });
    }

    const meminfo = await hostExecutor.executeCommand('cat', ['/proc/meminfo']);
    const kb = (key: string) => {
      const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(meminfo.stdout);
      return m ? Number(m[1]) : 0;
    };
    result.stillSwappedKb = Math.max(0, kb('SwapTotal') - kb('SwapFree'));
    if (result.stillSwappedKb > 0) {
      result.reclaimHint =
        `${(result.stillSwappedKb / 1024).toFixed(0)} MB is still parked in swap. `
        + 'The policy stops it growing but cannot pull it back: run '
        + '"swapoff -a && swapon -a" on the host once, when free memory exceeds '
        + 'that figure. Do not restart an NF to clear it.';
    }

    const notApplied = result.units.filter(u => u.swapMax !== '0').map(u => u.unit);
    if (notApplied.length > 0) {
      logger.warn({ units: notApplied },
        'NF memory policy: MemorySwapMax did not reach the cgroup for some units');
    }
    logger.info(
      {
        swappiness: result.swappiness,
        noSwapUnits: result.units.length - notApplied.length,
        stillSwappedMb: Math.round(result.stillSwappedKb / 1024),
      },
      'Applied Open5GS NF memory policy',
    );
  } catch (err) {
    result.error = String(err);
    logger.warn({ err: result.error }, 'NF memory policy failed');
  }

  return result;
}
