/**
 * TWAMP Prometheus exporter — same reasoning as
 * traffic-history/prometheus-metrics.ts: reuse the existing Prometheus+
 * Grafana stack (already scraping this backend's own /metrics) instead of
 * building a second time-series store for TWAMP history.
 *
 * Unlike that file's gauges (which read an already-current counter fresh on
 * every scrape), these read from TwampMonitor's in-memory cache — the
 * background poller, not this collect() call, is what actually runs the
 * ~10s TWAMP test. See twamp-monitor.ts's class comment for why.
 */

import * as client from 'prom-client';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { TwampCachedResult, TwampMonitor } from './twamp-monitor';
import { isTwampServerInstalled, readTwampState, getFullConnections, getLightPeers } from './twamp-runner';

export function createTwampMetricsRegistry(twampMonitor: TwampMonitor, hostExecutor: IHostExecutor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_twamp_test_success',
    help: '1 if the most recent TWAMP test against this target succeeded, 0 otherwise',
    labelNames: ['target'],
    registers: [registry],
    async collect() {
      const results = await twampMonitor.getLatestResults();
      for (const r of results) this.set({ target: r.name }, r.success ? 1 : 0);
    },
  });

  new client.Gauge({
    name: 'open5gs_twamp_packet_loss_ratio',
    help: 'Fraction of TWAMP test packets lost on the most recent successful test against this target (0-1)',
    labelNames: ['target'],
    registers: [registry],
    async collect() {
      const results = await twampMonitor.getLatestResults();
      for (const r of results) {
        if (!r.success || !r.packetsSent) continue;
        this.set({ target: r.name }, (r.packetsLost ?? 0) / r.packetsSent);
      }
    },
  });

  // The remaining series only mean anything for a test that actually
  // succeeded — a stale/missing series in Grafana for a target whose last
  // test failed is the correct representation, not a 0 value that would
  // look like a real (excellent) measurement.
  const delayGauge = (name: string, help: string, pick: (r: TwampCachedResult) => number | undefined) => {
    new client.Gauge({
      name, help, labelNames: ['target'], registers: [registry],
      async collect() {
        const results = await twampMonitor.getLatestResults();
        for (const r of results) {
          if (!r.success) continue;
          const v = pick(r);
          if (v !== undefined) this.set({ target: r.name }, v);
        }
      },
    });
  };

  delayGauge('open5gs_twamp_rtt_avg_ms', 'Average TWAMP round-trip time in milliseconds', r => r.avgRttMs);
  delayGauge('open5gs_twamp_rtt_min_ms', 'Minimum TWAMP round-trip time in milliseconds', r => r.minRttMs);
  delayGauge('open5gs_twamp_rtt_max_ms', 'Maximum TWAMP round-trip time in milliseconds', r => r.maxRttMs);
  delayGauge('open5gs_twamp_jitter_ms', 'TWAMP round-trip time jitter (standard deviation) in milliseconds', r => r.jitterMs);
  delayGauge('open5gs_twamp_forward_delay_avg_ms', 'Average one-way sender-to-reflector delay in milliseconds — requires synchronized clocks (see the Time Server page)', r => r.avgForwardDelayMs);
  delayGauge('open5gs_twamp_reverse_delay_avg_ms', 'Average one-way reflector-to-sender delay in milliseconds — requires synchronized clocks (see the Time Server page)', r => r.avgReverseDelayMs);
  delayGauge('open5gs_twamp_delay_asymmetry_ms', 'Forward/reverse one-way delay asymmetry ratio', r => r.delayAsymmetryMs);

  // ── Reflector (server) side — the reverse direction: OTHER devices (e.g.
  // a radio) testing INBOUND against this host. Independent of the
  // client-side gauges above (which measure US testing OUT against a
  // target). Only meaningful if twamp-server is installed+configured; reads
  // the same two data sources the Info & Stats "Connected Clients" table
  // uses (getFullConnections/getLightPeers) so this and that UI can never
  // disagree about what's actually connected.
  new client.Gauge({
    name: 'open5gs_twamp_reflector_installed',
    help: '1 if twamp-server (the reflector) is installed on this host, 0 otherwise',
    registers: [registry],
    collect() { this.set(isTwampServerInstalled() ? 1 : 0); },
  });

  new client.Gauge({
    name: 'open5gs_twamp_reflector_active_peers',
    help: 'Number of distinct remote peers currently testing against this reflector, by protocol',
    labelNames: ['protocol'],
    registers: [registry],
    async collect() {
      if (!isTwampServerInstalled()) return;
      const state = readTwampState()?.server;
      if (!state?.listenPort) return;
      const [full, light] = await Promise.all([
        state.enableFull ? getFullConnections(hostExecutor, state.listenPort) : Promise.resolve([]),
        state.enableLight ? getLightPeers(hostExecutor) : Promise.resolve([]),
      ]);
      this.set({ protocol: 'full' }, full.length);
      this.set({ protocol: 'light' }, light.length);
    },
  });

  return registry;
}
