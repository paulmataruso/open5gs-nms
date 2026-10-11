import * as client from 'prom-client';
import { AsteriskStatsMonitor, ASTERISK_INSTANCES } from './asterisk-stats-monitor';

/**
 * Asterisk Prometheus exporter — same sibling-registry pattern as every
 * other registry in this codebase. collect() only ever reads
 * AsteriskStatsMonitor's in-memory cache — never invokes the Asterisk CLI
 * itself — for the same reason as always: index.ts's single /metrics
 * handler awaits every registry's metrics() in one response, so a slow
 * collect() here would risk the scrape timeout for every OTHER registry
 * sharing that response too.
 *
 * Gauge, never Counter — open5gs_asterisk_calls_processed_total is
 * Asterisk's own process-lifetime counter, which resets to 0 on a service
 * restart (a real, ordinary event for both instances). Gauge.set()
 * tolerates that drop gracefully; Counter.inc() would throw on the implied
 * negative delta.
 *
 * Deliberately NOT exposed: a "contact qualified/reachable" gauge.
 * Confirmed live — no `qualify_frequency` is configured on any AOR on
 * either instance, so every contact permanently reports NonQual. A gauge
 * that can only ever read one constant value is noise, not a real signal
 * — see this feature's own dashboard (asterisk.json) for the explicit
 * scope-note on this instead.
 *
 * Real bug, found 2026-09-25 (the dashboard showed no data in ANY card):
 * the label was originally just named "instance" — but Prometheus itself
 * always attaches its OWN "instance" label to every scraped series
 * (identifying the scrape target, e.g. "127.0.0.1:3001"), and with
 * honor_labels:false (this deployment's scrape config, prometheus.yml —
 * left at the default deliberately, see cdr-metrics.ts's own copy of this
 * comment for why NOT flipping it globally was the safer fix), a metric's
 * OWN same-named label loses the collision: Prometheus renames it to
 * "exported_instance" and overwrites "instance" with the scrape target's
 * address. Confirmed live via Prometheus's own /api/v1/query — every
 * open5gs_asterisk_* series had exported_instance="pstn"/"2g" and
 * instance="127.0.0.1:3001", while every dashboard panel queried
 * `instance="pstn"`/`{{instance}}` — zero series ever matched. Renamed to
 * "asterisk_instance" here (never colliding with Prometheus's reserved
 * name) instead of setting honor_labels:true on the scrape job, which
 * would have silently changed "instance" behavior for every OTHER
 * registry sharing this same /metrics endpoint too.
 */

export function createAsteriskMetricsRegistry(monitor: AsteriskStatsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_asterisk_up', help: '1 if the last CLI poll against this Asterisk instance succeeded and parsed cleanly',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) this.set({ asterisk_instance: instance }, latest.get(instance)?.up ? 1 : 0);
    },
  });

  // Every collect() below calls this.reset() first — real, confirmed-live 2026-09-29
  // finding (full-session wiring audit): without it, an instance that goes down (a
  // real, ordinary event — a service restart) or an endpoint/transport that
  // disappears (a toggle turned off) just keeps reporting its last-known value
  // forever instead of a gap. Same staleness bug class already fixed for
  // TWAMP/OCS/GSM elsewhere in this same session.
  new client.Gauge({
    name: 'open5gs_asterisk_channels_active', help: 'Currently active channels ("core show channels count")',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (s?.up) this.set({ asterisk_instance: instance }, s.channelsActive);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_calls_active', help: 'Currently active calls ("core show channels count")',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (s?.up) this.set({ asterisk_instance: instance }, s.callsActive);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_calls_processed_total', help: 'Cumulative calls processed since this instance\'s own process start (resets on a service restart — accurate, not a bug, same reasoning as every other process-lifetime Gauge in this codebase)',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (s?.up) this.set({ asterisk_instance: instance }, s.callsProcessedTotal);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_pjsip_endpoint_configured', help: '1 per PJSIP endpoint currently present in "pjsip show endpoints" — naturally reflects toggle state (Cross-RAN Calling, External SIP Trunk), never a hardcoded endpoint list',
    labelNames: ['asterisk_instance', 'endpoint'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (!s?.up) continue;
        for (const ep of s.endpoints) this.set({ asterisk_instance: instance, endpoint: ep.name }, 1);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_pjsip_endpoint_channels_active', help: 'Active channel count per PJSIP endpoint (the "N of inf" figure)',
    labelNames: ['asterisk_instance', 'endpoint'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (!s?.up) continue;
        for (const ep of s.endpoints) this.set({ asterisk_instance: instance, endpoint: ep.name }, ep.channelsActive);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_pjsip_transport_bound', help: '1 per PJSIP transport currently present in "pjsip show transports" — confirms the transport actually bound, not just that it exists in the config file',
    labelNames: ['asterisk_instance', 'transport', 'bind_address'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (!s?.up) continue;
        for (const t of s.transports) this.set({ asterisk_instance: instance, transport: t.name, bind_address: t.bindAddress }, 1);
      }
    },
  });

  // Purpose-built convenience gauges so a dashboard/alert author doesn't
  // need to know Asterisk's internal per-instance endpoint-naming scheme
  // (pattern #16: pstn's own peer endpoint is named "asterisk2g_trunk",
  // asterisk-2g's own peer endpoint is named "pstn_trunk").
  new client.Gauge({
    name: 'open5gs_asterisk_cross_ran_trunk_configured', help: '1 iff THIS instance\'s own Cross-RAN Calling peer endpoint is present (pattern #16) — min() across both instance labels is 1 only when both sides are genuinely wired',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      this.reset();
      const latest = monitor.getLatest();
      const peerEndpoint: Record<string, string> = { pstn: 'asterisk2g_trunk', '2g': 'pstn_trunk' };
      for (const instance of ASTERISK_INSTANCES) {
        const s = latest.get(instance);
        if (!s?.up) continue;
        this.set({ asterisk_instance: instance }, s.endpoints.some(ep => ep.name === peerEndpoint[instance]) ? 1 : 0);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_asterisk_external_trunk_configured', help: '1 iff PSTN Gateway\'s external_trunk endpoint is present (only ever meaningful for instance="pstn")',
    labelNames: ['asterisk_instance'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest().get('pstn');
      if (s?.up) this.set({ asterisk_instance: 'pstn' }, s.endpoints.some(ep => ep.name === 'external_trunk') ? 1 : 0);
    },
  });

  return registry;
}
