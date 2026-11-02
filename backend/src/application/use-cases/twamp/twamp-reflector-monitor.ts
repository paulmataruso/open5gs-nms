import { Db } from 'mongodb';
import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import {
  isTwampServerInstalled, readTwampState, getFullConnections, getLightPeers,
  getReflectorMetrics, lightPacketCountersByIp,
  TWAMP_SERVER_UNIT, ServerConnectionEntry, TwampProtocol,
} from './twamp-runner';
import {
  recordReflectorHistorySample, reflectorCounterDelta, reflectorPacketRate,
  ReflectorPeerSample, TwampReflectorSample,
} from './twamp-reflector-history';

// ── Reflector history sampler ────────────────────────────────────────────
//
// The client-side counterpart (TwampMonitor) runs a real ~10s network test
// per target, which is why it is decoupled from Prometheus's scrape
// interval. This one is the opposite: a tick is one `systemctl is-active`,
// one loopback curl, and (only when full protocol is enabled) one `ss` —
// cheap, local, and bounded by the number of radios actually testing
// against us. So it can afford a steady, fine cadence.
//
// 30s is chosen against the thing being measured, not picked for a round
// number: twamp-server.go drops a TWAMP-Light peer from its "connected"
// view after 5 minutes of silence (lightPeerStaleAfter), so a peer's
// shortest possible observable presence is that window. Sampling at 30s
// puts ~10 observations inside it, which is enough for a presence graph to
// show a radio appearing and disappearing rather than aliasing it away,
// while still being coarse enough that 30 days of history is ~86k small
// documents.
const TICK_MS = 30_000;

export class TwampReflectorMonitor {
  private readonly timer: NodeJS.Timeout;
  // Previous tick's per-peer cumulative counters, for the delta. In memory
  // only, deliberately: a backend restart should produce one tick with no
  // delta (honestly "unknown") rather than a delta spanning however long
  // the backend was down, which would land an hour of traffic on a single
  // 30-second sample and read as a huge spike.
  private prevCounters: Record<string, number> = {};
  private prevSampleAt = 0;
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err: String(err) }, 'twamp reflector monitor tick failed'));
    }, TICK_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    // Nothing to sample until the reflector half of this module actually
    // exists on this host. Writing "0 peers, service down" for a
    // deployment that never configured a reflector would fill the store
    // with a flat line that looks like an outage.
    if (!isTwampServerInstalled()) return;
    const server = readTwampState()?.server;
    if (!server?.listenPort) return;

    this.ticking = true;
    try {
      const activeRes = await this.hostExecutor
        .executeCommand('systemctl', ['is-active', TWAMP_SERVER_UNIT], 10_000, { expectedFailure: true })
        .catch(() => null);
      const serviceActive = activeRes?.stdout.trim() === 'active';

      let full: ServerConnectionEntry[] = [];
      let light: ServerConnectionEntry[] = [];
      let counters: Record<string, number> = {};
      if (serviceActive) {
        const [fullRes, lightRes, metricsRes] = await Promise.all([
          server.enableFull ? getFullConnections(this.hostExecutor, server.listenPort).catch(() => []) : Promise.resolve([]),
          server.enableLight ? getLightPeers(this.hostExecutor).catch(() => []) : Promise.resolve([]),
          getReflectorMetrics(this.hostExecutor).catch(() => ({ available: false, data: [] })),
        ]);
        full = fullRes;
        light = lightRes;
        counters = lightPacketCountersByIp(metricsRes.data);
      }

      const now = Date.now();
      const elapsedMs = this.prevSampleAt > 0 ? now - this.prevSampleAt : 0;
      const sample = buildReflectorSample({
        timestampMs: now,
        serviceActive,
        enableFull: !!server.enableFull,
        enableLight: !!server.enableLight,
        full,
        light,
        counters,
        prevCounters: this.prevCounters,
        elapsedMs,
      });

      // Only the counters actually observed this tick carry forward. A
      // peer's counter that disappeared (the reflector restarted and has
      // not seen it since) must not keep acting as a baseline, or its next
      // appearance would compute a delta against a pre-restart value.
      this.prevCounters = serviceActive ? counters : {};
      this.prevSampleAt = serviceActive ? now : 0;

      await recordReflectorHistorySample(this.db, sample);
    } finally {
      this.ticking = false;
    }
  }
}

export interface BuildReflectorSampleInput {
  timestampMs: number;
  serviceActive: boolean;
  enableFull: boolean;
  enableLight: boolean;
  full: ServerConnectionEntry[];
  light: ServerConnectionEntry[];
  counters: Record<string, number>;
  prevCounters: Record<string, number>;
  elapsedMs: number;
}

/**
 * Collapses one tick's raw readings into the stored document.
 *
 * Exported and pure so the counter/reset/rate arithmetic and the
 * ip:port-to-ip collapsing are testable without a Mongo or a host.
 *
 * Peer counts are DISTINCT PEER IPs, which is a deliberate difference from
 * the live Connected Clients table (one row per ip:port session) and from
 * the reflector's own twamp_light_active_peers gauge (which also counts
 * sessions). "How many clients are connected" means devices to an operator,
 * and one radio opening a second ephemeral source port is not a second
 * client. The per-session detail is kept as `sessions` on each peer rather
 * than discarded.
 */
export function buildReflectorSample(input: BuildReflectorSampleInput): TwampReflectorSample {
  const byIp = new Map<string, { protocol: TwampProtocol; sessions: number; lastSeenMs?: number }>();
  const add = (e: ServerConnectionEntry) => {
    const existing = byIp.get(e.peerIp);
    if (existing) {
      existing.sessions += 1;
      if (e.lastSeenMs !== undefined) {
        existing.lastSeenMs = Math.max(existing.lastSeenMs ?? 0, e.lastSeenMs);
      }
      return;
    }
    byIp.set(e.peerIp, { protocol: e.protocol, sessions: 1, lastSeenMs: e.lastSeenMs });
  };
  for (const e of input.full) add(e);
  for (const e of input.light) add(e);

  const peers: ReflectorPeerSample[] = [];
  let packetsPerSecTotal: number | undefined;
  for (const [peerIp, info] of byIp) {
    const peer: ReflectorPeerSample = {
      peerIp,
      protocol: info.protocol,
      sessions: info.sessions,
      lastSeenMs: info.lastSeenMs,
    };
    // Full-protocol peers have no per-peer counter at all (the library
    // only exposes aggregate session/packet counters by mode and role), so
    // they carry presence and session count but no throughput — left
    // undefined rather than zero, which would claim a measurement.
    const cur = input.counters[peerIp];
    if (cur !== undefined) {
      peer.packetsReflected = cur;
      const delta = reflectorCounterDelta(input.prevCounters[peerIp], cur);
      if (delta !== undefined) {
        peer.packetsDelta = delta;
        const rate = reflectorPacketRate(delta, input.elapsedMs);
        if (rate !== undefined) {
          peer.packetsPerSec = rate;
          packetsPerSecTotal = (packetsPerSecTotal ?? 0) + rate;
        }
      }
    }
    peers.push(peer);
  }

  const fullPeers = peers.filter(p => p.protocol === 'full').length;
  const lightPeers = peers.filter(p => p.protocol === 'light').length;

  return {
    timestamp: new Date(input.timestampMs),
    serviceActive: input.serviceActive,
    enableFull: input.enableFull,
    enableLight: input.enableLight,
    fullPeers,
    lightPeers,
    totalPeers: fullPeers + lightPeers,
    packetsPerSec: packetsPerSecTotal,
    peers,
  };
}
