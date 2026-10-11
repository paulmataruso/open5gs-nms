/**
 * rtpengine Prometheus exporter — same sibling-registry pattern as
 * traffic-history/prometheus-metrics.ts, twamp/twamp-metrics.ts, and
 * gsm/gsm-metrics.ts. collect() only ever reads RtpengineStatsMonitor's
 * in-memory cache — never queries rtpengine itself — for the same reason
 * those three files give: index.ts's single /metrics handler awaits every
 * registered registry's metrics() in one response, so a slow/hung query
 * here would add latency (or blow the scrape_timeout) for the unrelated
 * registries sharing that response.
 *
 * open5gs_ims_rtpengine_up is the standard Prometheus "is this target even
 * alive" idiom — without it, a real rtpengine outage would otherwise just
 * look like a flat line at the monitor's last-known-good numbers instead of
 * visibly going stale (the exact gap an adversarial review of this task
 * caught and required be closed).
 */

import * as client from 'prom-client';
import { RtpengineStatsMonitor } from './rtpengine-stats-monitor';

export function createImsRtpengineMetricsRegistry(monitor: RtpengineStatsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_ims_rtpengine_up', help: '1 if the last rtpengine NG statistics query succeeded, 0 otherwise',
    registers: [registry], collect() { this.set(monitor.getLatest().up ? 1 : 0); },
  });

  const gauge = (name: string, help: string, pick: (s: ReturnType<RtpengineStatsMonitor['getLatest']>) => number) => {
    new client.Gauge({
      name, help, registers: [registry],
      collect() {
        // Real, confirmed-live 2026-09-29 finding (full-session wiring audit): this
        // comment used to describe the INTENDED behavior ("stale-but-plausible is
        // worse than absent") while the code underneath did the opposite — skipping
        // .set() on a down monitor left the gauge frozen at its last real value
        // instead of going to a gap. reset() actually delivers what the comment
        // always claimed.
        this.reset();
        const s = monitor.getLatest();
        if (!s.up) return;
        this.set(pick(s));
      },
    });
  };

  gauge('open5gs_ims_rtpengine_sessions_active', 'Currently active RTP sessions (own + foreign, per rtpengine\'s own accounting)', s => s.sessionsActive);
  gauge('open5gs_ims_rtpengine_sessions_transcoded', 'Currently active sessions requiring codec transcoding', s => s.sessionsTranscoded);
  gauge('open5gs_ims_rtpengine_port_pool_used', 'RTP port pool ports currently in use', s => s.portPoolUsed);
  gauge('open5gs_ims_rtpengine_port_pool_free', 'RTP port pool ports currently free', s => s.portPoolFree);
  gauge('open5gs_ims_rtpengine_port_pool_max', 'RTP port pool total configured size', s => s.portPoolMax);
  gauge('open5gs_ims_rtpengine_managed_sessions_total', 'Cumulative sessions managed since the rtpengine process started (resets to 0 on restart)', s => s.managedSessionsTotal);
  gauge('open5gs_ims_rtpengine_rejected_sessions_total', 'Cumulative rejected sessions since process start', s => s.rejectedSessionsTotal);
  gauge('open5gs_ims_rtpengine_timeout_sessions_total', 'Cumulative timed-out sessions since process start', s => s.timeoutSessionsTotal);
  gauge('open5gs_ims_rtpengine_mos_average', 'Average MOS (Mean Opinion Score) across measured calls since process start — stays 0 unless RTCP-based quality measurement has real data to report', s => s.mosAverage);
  gauge('open5gs_ims_rtpengine_uptime_seconds', 'rtpengine process uptime', s => s.uptimeSeconds);

  new client.Gauge({
    name: 'open5gs_ims_rtpengine_byte_rate', help: 'Current relayed byte rate (bytes/sec), by relay plane',
    labelNames: ['plane'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      this.set({ plane: 'userspace' }, s.byteRateUser);
      this.set({ plane: 'kernel' }, s.byteRateKernel);
    },
  });

  new client.Gauge({
    name: 'open5gs_ims_rtpengine_packet_rate', help: 'Current relayed packet rate (packets/sec), by relay plane',
    labelNames: ['plane'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      this.set({ plane: 'userspace' }, s.packetRateUser);
      this.set({ plane: 'kernel' }, s.packetRateKernel);
    },
  });

  new client.Gauge({
    name: 'open5gs_ims_rtpengine_relayed_bytes_total', help: 'Cumulative relayed bytes since process start, by relay plane (resets to 0 on restart)',
    labelNames: ['plane'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      this.set({ plane: 'userspace' }, s.relayedBytesUserTotal);
      this.set({ plane: 'kernel' }, s.relayedBytesKernelTotal);
    },
  });

  // Direct, quantifiable signal for the B2BUA dual-dialog RTP relay gap
  // class documented in this project's own CLAUDE.md (architectural
  // patterns #14/#16) — a stream that only ever carries traffic one
  // direction, or never at all, is exactly what those incidents looked
  // like from rtpengine's own point of view.
  new client.Gauge({
    name: 'open5gs_ims_rtpengine_call_quality_streams_total', help: 'Cumulative streams by observed direction quality since process start (resets to 0 on restart) — see CLAUDE.md patterns #14/#16 for the real incident class this detects',
    labelNames: ['type'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      this.set({ type: 'one_way' }, s.oneWayStreamsTotal);
      this.set({ type: 'zero_way' }, s.zeroWayStreamsTotal);
    },
  });

  return registry;
}
