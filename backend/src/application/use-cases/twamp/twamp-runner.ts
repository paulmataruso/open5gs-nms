import * as fs from 'fs';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';

// ── TWAMP client runner — shared between the on-demand /test endpoint
// (twamp-controller.ts) and the background poller (twamp-monitor.ts), so the
// actual "spawn the binary, parse its JSON" logic only lives in one place.

export const HOST_ROOT = '/proc/1/root';
export const TWAMP_DIR = '/opt/open5gs-nms/twamp';
export const TWAMP_SRC = `${TWAMP_DIR}/twamp-client.go`;
export const TWAMP_BIN = `${TWAMP_DIR}/twamp-client`;
export const TWAMP_SERVER_SRC = `${TWAMP_DIR}/twamp-server.go`;
export const TWAMP_SERVER_BIN = `${TWAMP_DIR}/twamp-server`;
export const TWAMP_SERVER_UNIT = 'twamp-server';
export const TWAMP_SERVER_UNIT_PATH = `/etc/systemd/system/${TWAMP_SERVER_UNIT}.service`;
// Loopback-only — matches twamp-server.go's own -metrics-addr default.
export const TWAMP_SERVER_METRICS_ADDR = '127.0.0.1:9271';
// Loopback-only — matches twamp-server.go's own -light-peers-addr default.
// TWAMP-Light is connectionless UDP, so unlike the full-protocol reflector
// there's no OS-level "connection" for `ss` to find — the server tracks its
// own recently-seen senders and exposes them here.
export const TWAMP_SERVER_LIGHT_PEERS_ADDR = '127.0.0.1:9272';
// Matches github.com/ncode/twamp's own go.mod `go` directive — a real
// dependency of OUR module (twamp-client.go/twamp-server.go import it), not
// just a self-imposed pin, so this can't be loosened without checking
// upstream.
export const GO_VERSION = '1.25.6';

export interface TwampServerState {
  configuredWithVersion?: string;
  listenIp: string;
  listenPort: number;
  // Both protocols bind the SAME listenIp/listenPort — full uses TCP, light
  // uses UDP, so there's no actual conflict, and this covers the real need
  // (accept whichever variant a given device speaks) without an extra
  // "separate light address" control nobody's asked for.
  enableFull: boolean;
  enableLight: boolean;
  modes: TwampMode[];
  secretKeyId?: string;
  secretValue?: string;
  allowCidrs?: string[];
}

export interface TwampState {
  installedWithVersion?: string;
  server?: TwampServerState;
  history?: { retentionDays: number };
}

// Shared between twamp-controller.ts (reads/writes it directly) and
// twamp-monitor.ts (reads it read-only, to know the reflector's own
// listen port/protocol for its Prometheus reflector-side gauges) — a single
// source of truth for this module's on-host persisted state.
export const HOST_TWAMP_STATE = `${HOST_ROOT}/etc/open5gs/.twamp-config.json`;

export function readTwampState(): TwampState | null {
  if (!fs.existsSync(HOST_TWAMP_STATE)) return null;
  try { return JSON.parse(fs.readFileSync(HOST_TWAMP_STATE, 'utf-8')); } catch { return null; }
}
export function writeTwampState(state: TwampState): void {
  fs.mkdirSync(`${HOST_ROOT}/etc/open5gs`, { recursive: true });
  fs.writeFileSync(HOST_TWAMP_STATE, JSON.stringify(state, null, 2), 'utf-8');
}

export type TwampMode = 'unauthenticated' | 'authenticated' | 'encrypted';
// full = RFC 5357 main body (TCP TWAMP-Control then UDP test packets).
// light = RFC 5357 Appendix I (connectionless UDP only, no control
// handshake) — confirmed live 2026-08-24 via packet capture that a real
// Nokia AirScale radio's reflector only speaks this variant; twamp-client.go
// hand-rolls it since github.com/ncode/twamp has no support for it at all.
export type TwampProtocol = 'full' | 'light';

export interface TwampTarget {
  host: string;
  port: number;
  protocol: TwampProtocol;
  mode: TwampMode;
  sharedSecret?: string;
  keyId?: string;
  packetCount: number;
  // This host is multi-homed (several RAN-facing subnets on different
  // interfaces) — without an explicit bind IP, the OS's default route
  // selection isn't guaranteed to reach a given reflector's subnet. See
  // patch-bind-ip.py for how this is threaded into the library, which has
  // no LocalAddr-equivalent option of its own.
  bindIp?: string;
}

export interface TwampTestResult {
  success: boolean;
  error?: string;
  packetsSent?: number;
  packetsReceived?: number;
  packetsLost?: number;
  minRttMs?: number;
  maxRttMs?: number;
  avgRttMs?: number;
  jitterMs?: number;
  avgForwardDelayMs?: number;
  avgReverseDelayMs?: number;
  delayAsymmetryMs?: number;
}

export interface ServerConnectionEntry {
  peerIp: string;
  peerPort: string;
  localAddr: string;
  protocol: TwampProtocol;
  packetCount?: number;
  lastSeenMs?: number;
}

// Real TCP peers currently connected to the reflector's TWAMP-Control port
// — the library itself has no exported API to list active connections (only
// aggregate Prometheus counters), so this reads straight from the kernel's
// own connection table for genuine per-client identity. This only ever
// finds full-protocol (TCP) clients — see getLightPeers() below for why
// TWAMP-Light needs a completely different approach. Shared by
// twamp-controller.ts's /server/connections endpoint and twamp-metrics.ts's
// Prometheus gauges — one source of truth for "how do we count reflector
// clients" instead of two copies drifting apart.
export async function getFullConnections(hostExecutor: IHostExecutor, port: number): Promise<ServerConnectionEntry[]> {
  const result = await hostExecutor.executeCommand('ss', ['-tn', 'state', 'established', `( sport = :${port} )`]);
  const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  // First line is the ss column header — skip it.
  return lines.slice(1).map(line => {
    const parts = line.split(/\s+/);
    const peer = parts[parts.length - 1] ?? '';
    const local = parts[parts.length - 2] ?? '';
    const idx = peer.lastIndexOf(':');
    return {
      peerIp: idx >= 0 ? peer.slice(0, idx) : peer,
      peerPort: idx >= 0 ? peer.slice(idx + 1) : '',
      localAddr: local,
      protocol: 'full' as TwampProtocol,
    };
  });
}

// TWAMP-Light is connectionless UDP — there is no OS-level "connection" for
// `ss` to find the way getFullConnections() does for TCP (confirmed live
// 2026-08-24: a real Nokia radio sending ~10 UDP test packets/sec, visibly
// reflected correctly via tcpdump, produced zero rows from `ss -tn` because
// this deployment's reflector runs Light-only — enableFull is false, so
// there's no TCP listener at all). twamp-server.go tracks its own
// recently-seen senders in memory instead and exposes them on a small
// loopback-only HTTP endpoint; this just proxies that.
export async function getLightPeers(hostExecutor: IHostExecutor): Promise<ServerConnectionEntry[]> {
  const result = await hostExecutor.executeCommand('curl', ['-fsS', `http://${TWAMP_SERVER_LIGHT_PEERS_ADDR}/light-peers`], 5000);
  if (result.exitCode !== 0) return [];
  try {
    const peers = JSON.parse(result.stdout) as Array<{ peerIp: string; peerPort: string; lastSeenMs: number; packetCount: number }>;
    return peers.map(p => ({
      peerIp: p.peerIp,
      peerPort: p.peerPort,
      localAddr: '',
      protocol: 'light' as TwampProtocol,
      packetCount: p.packetCount,
      lastSeenMs: p.lastSeenMs,
    }));
  } catch {
    return [];
  }
}

export function isTwampInstalled(): boolean {
  return fs.existsSync(`${HOST_ROOT}${TWAMP_BIN}`);
}

export function isTwampServerInstalled(): boolean {
  return fs.existsSync(`${HOST_ROOT}${TWAMP_SERVER_BIN}`);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Real, reproduced-live bug (2026-09-25, found building the TWAMP Grafana
// dashboard — both a planning and a critic agent independently confirmed
// this end-to-end, the critic down to the millisecond against a real
// target): TWAMP-Light (runLight() in twamp-client.go, the protocol every
// real target on this deployment uses) blocks PER PACKET on the binary's
// own `-timeout-ms` flag (previously never passed here, so it fell back to
// the binary's own hardcoded default of 5000ms) plus an unconditional
// `-interval-ms` sleep (previously also never passed, default 1000ms) —
// so one LOST packet costs up to timeout+interval (6000ms under the old
// defaults), not the ~1200ms/packet the old `timeoutMs` formula below
// assumed. As few as 3 lost packets out of the default 10-packet count
// already exceeded that old 20s external budget — ordinary packet loss,
// not just a total outage, which is exactly the condition TWAMP exists to
// measure. When the external timeout fired, the wrapped process was
// correctly killed (see safe-nsenter.ts) but had written nothing to
// stdout yet — and the parse step used to fall back to the literal string
// `'{}'` on empty stdout, which `JSON.parse`s successfully into an object
// with every field `undefined`, silently skipping the catch block that
// would have preserved the real "timed out" error. Confirmed live in
// Mongo: every recent sample for all 3 real targets had every field
// `null`, not a real `success:false` + a real error message.
//
// Fixed two ways, not just one: (1) explicitly pass `-timeout-ms`/
// `-interval-ms` to the binary below instead of relying on its own
// hardcoded defaults, and derive the external `timeoutMs` from these SAME
// constants, so the two can never independently drift apart again — the
// old bug was exactly this kind of implicit, unstated cross-file coupling
// (same class of gotcha as CLAUDE.md patterns #17/#18); (2) a genuinely
// empty stdout is now treated as a real failure, never silently parsed as
// an empty-but-"successful" object. PER_PACKET_TIMEOUT_MS is also
// deliberately lower than the binary's old 5000ms default — these are
// real, directly-attached-subnet RAN radios (LAN-local, not
// internet-routed), so 5s per lost packet was needless margin; 3s still
// leaves generous headroom while roughly halving a fully-down target's
// worst-case test duration.
const PER_PACKET_TIMEOUT_MS = 3000;
const INTERVAL_MS = 1000; // matches twamp-client's own previous default
const FIXED_OVERHEAD_MS = 5000; // process spawn / nsenter / handshake margin

// Runs one TWAMP test session against `target` and returns its parsed
// result. Never throws — a connect/timeout/protocol failure comes back as
// `{ success: false, error }`, same as the binary's own stdout contract (see
// twamp-client.go's header comment), so callers never need a try/catch just
// to handle "reflector didn't answer".
export async function runTwampTest(hostExecutor: IHostExecutor, target: TwampTarget): Promise<TwampTestResult> {
  const packetCount = target.packetCount > 0 ? target.packetCount : 10;
  const args = [
    TWAMP_BIN,
    '-addr', shellQuote(`${target.host}:${target.port}`),
    '-protocol', shellQuote(target.protocol || 'full'),
    '-mode', shellQuote(target.mode),
    '-count', String(packetCount),
    '-timeout-ms', String(PER_PACKET_TIMEOUT_MS),
    '-interval-ms', String(INTERVAL_MS),
  ];
  if (target.sharedSecret) args.push('-secret', shellQuote(target.sharedSecret));
  if (target.keyId) args.push('-keyid', shellQuote(target.keyId));
  if (target.bindIp) args.push('-bind-ip', shellQuote(target.bindIp));

  // Worst case: every packet lost, each costing timeout+interval, plus
  // fixed overhead — derived from the exact same constants passed to the
  // binary above, so this can never silently drift out of sync with them
  // again the way the old hardcoded "~1200ms/packet" guess did.
  const timeoutMs = packetCount * (PER_PACKET_TIMEOUT_MS + INTERVAL_MS) + FIXED_OVERHEAD_MS;
  // A reflector being unreachable (no reply within timeout) is a normal,
  // common outcome here — twamp-client exits nonzero for it, but it's not
  // an unexpected/actionable backend error, just a target that's currently
  // down. Keep it out of error-level logs the same way systemctl is-active
  // already is.
  const result = await hostExecutor.executeCommand('bash', ['-c', args.join(' ')], timeoutMs, { expectedFailure: true });

  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  if (line) {
    try {
      return JSON.parse(line) as TwampTestResult;
    } catch {
      // fall through to the same real-error construction below
    }
  }
  return {
    success: false,
    error: result.stderr || result.stdout || `twamp-client exited ${result.exitCode} with no parseable output`,
  };
}
