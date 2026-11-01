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
