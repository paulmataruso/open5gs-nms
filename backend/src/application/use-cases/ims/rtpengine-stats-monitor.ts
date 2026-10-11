/**
 * rtpengine stats background poller — sibling to call-stats-monitor.ts's
 * own shape (constructor takes what it needs, start() fires an initial
 * sample then a setInterval, both wrapped in try/catch so a failure can
 * never escape uncaught into the interval — this codebase has no global
 * unhandledRejection handler, confirmed multiple times this session, and an
 * escaping rejection crash-loops the entire backend, not just this
 * feature).
 *
 * Real field-type gotcha, confirmed against a live query against this
 * project's own rtpengine instance (2026-09-25): bencode has no native
 * float type, so rtpengine encodes every non-integer numeric value (uptime,
 * MOS/jitter/RTT/packetloss averages, port used_pct) as a bencode
 * byte-string of its decimal text, e.g. `8:0.000000`. Only genuine counts
 * (sessions, packets, bytes) come back as real bencode integers. `num()`
 * below normalizes either shape safely.
 */

import pino from 'pino';
import { rtpengineStatistics } from './rtpengine-ng-client';

export interface RtpengineStats {
  up: boolean;
  sessionsActive: number;
  sessionsTranscoded: number;
  byteRateUser: number;
  byteRateKernel: number;
  packetRateUser: number;
  packetRateKernel: number;
  portPoolUsed: number;
  portPoolFree: number;
  portPoolMax: number;
  managedSessionsTotal: number;
  relayedBytesUserTotal: number;
  relayedBytesKernelTotal: number;
  oneWayStreamsTotal: number;
  zeroWayStreamsTotal: number;
  rejectedSessionsTotal: number;
  timeoutSessionsTotal: number;
  mosAverage: number;
  uptimeSeconds: number;
  sampledAt: number;
}

const POLL_INTERVAL_MS = 15_000;

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

export class RtpengineStatsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private latest: RtpengineStats = {
    up: false, sessionsActive: 0, sessionsTranscoded: 0,
    byteRateUser: 0, byteRateKernel: 0, packetRateUser: 0, packetRateKernel: 0,
    portPoolUsed: 0, portPoolFree: 0, portPoolMax: 0,
    managedSessionsTotal: 0, relayedBytesUserTotal: 0, relayedBytesKernelTotal: 0,
    oneWayStreamsTotal: 0, zeroWayStreamsTotal: 0, rejectedSessionsTotal: 0, timeoutSessionsTotal: 0,
    mosAverage: 0, uptimeSeconds: 0, sampledAt: 0,
  };

  constructor(
    // Reads the rtpengine NG address IMS is actually configured with —
    // same source configureIms()'s own [rtpengine] block writes.
    private readonly getRtpEngineIp: () => string | null,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.debug({ err: String(err) }, 'rtpengine stats: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.debug({ err: String(err) }, 'rtpengine stats: sample failed'));
    }, POLL_INTERVAL_MS);
  }

  getLatest(): RtpengineStats {
    return this.latest;
  }

  private async sample(): Promise<void> {
    const ip = this.getRtpEngineIp();
    if (!ip) {
      // IMS not configured yet, or rtpengine section never written — leave
      // `up: false`, everything else at its last-known (or initial zero) value.
      this.latest = { ...this.latest, up: false, sampledAt: Date.now() };
      return;
    }
    try {
      const result = await rtpengineStatistics(ip);
      const stats = (result.statistics ?? {}) as Record<string, any>;
      const current = (stats.currentstatistics ?? {}) as Record<string, any>;
      const total = (stats.totalstatistics ?? {}) as Record<string, any>;
      const mos = (stats.mos ?? {}) as Record<string, any>;
      const iface = Array.isArray(stats.interfaces) && stats.interfaces.length > 0 ? stats.interfaces[0] : {};
      const ports = (iface.ports ?? {}) as Record<string, any>;

      this.latest = {
        up: true,
        sessionsActive: num(current.sessionstotal),
        sessionsTranscoded: num(current.transcodedmedia),
        byteRateUser: num(current.byterate_user),
        byteRateKernel: num(current.byterate_kernel),
        packetRateUser: num(current.packetrate_user),
        packetRateKernel: num(current.packetrate_kernel),
        portPoolUsed: num(ports.used),
        portPoolFree: num(ports.free),
        portPoolMax: num(ports.max),
        managedSessionsTotal: num(total.managedsessions),
        relayedBytesUserTotal: num(total.relayedbytes_user),
        relayedBytesKernelTotal: num(total.relayedbytes_kernel),
        oneWayStreamsTotal: num(total.onewaystreams),
        zeroWayStreamsTotal: num(total.zerowaystreams),
        rejectedSessionsTotal: num(total.rejectedsessions),
        timeoutSessionsTotal: num(total.timeoutsessions),
        mosAverage: num(mos.mos_average),
        uptimeSeconds: num(total.uptime),
        sampledAt: Date.now(),
      };
    } catch (err) {
      // rtpengine unreachable/timed out — surface as down, don't keep
      // reporting stale numbers as if they were current (matches
      // twamp-metrics.ts's own "stale-but-plausible is worse than absent"
      // principle, adapted here via an explicit `up` flag rather than
      // dropping the whole series, since a monitoring dashboard's "is it
      // even up" signal is itself the most important single fact).
      this.latest = { ...this.latest, up: false, sampledAt: Date.now() };
      throw err;
    }
  }
}
