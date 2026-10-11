import * as client from 'prom-client';
import { CdrMetricsMonitor } from './cdr-metrics-monitor';

/**
 * Prometheus exporter for CdrMetricsMonitor's own aggregation cache — same
 * sibling-registry pattern as every other registry in this codebase.
 * collect() only ever reads the monitor's in-memory snapshot, never
 * queries MongoDB itself. See cdr-metrics-monitor.ts's own header comment
 * for the disposition/sourceSystem filtering this data is already correct
 * by the time it reaches here.
 *
 * Real bug, found 2026-09-25 (the Asterisk dashboard's own CDR-sourced
 * panels showed no data, same symptom as every other panel there): this
 * file's "instance" label collided with Prometheus's own reserved
 * "instance" label (attached to every scraped series, identifying the
 * scrape target itself). With honor_labels:false (this deployment's
 * scrape config, prometheus.yml — left at the default; flipping it
 * globally would have silently changed "instance" behavior for every
 * OTHER registry sharing this same /metrics endpoint, a much larger blast
 * radius than fixing the two registries that actually chose a colliding
 * label name), Prometheus renamed this label to "exported_instance" and
 * overwrote "instance" with the scrape target's own address at ingest
 * time — confirmed live via Prometheus's own /api/v1/query. Renamed to
 * "instance" -> "cdr_instance" here, matching the same fix and reasoning
 * applied to asterisk-metrics.ts's own identical mistake (its own comment
 * has the full live-verification detail).
 */
export function createCdrMetricsRegistry(monitor: CdrMetricsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_cdr_metrics_up', help: '1 if the last periodic nms_cdr aggregation succeeded',
    registers: [registry],
    collect() { this.set(monitor.getLatest().up ? 1 : 0); },
  });

  // Every labeled collect() below calls this.reset() first — real,
  // confirmed-live 2026-09-29 finding (full-session wiring audit): without it, a
  // (instance, disposition, window) combination that stops appearing in a fresh
  // aggregation (or the whole monitor going down) keeps reporting its last-known
  // value forever instead of a gap. Same staleness bug class already fixed for
  // TWAMP/OCS/GSM/asterisk-metrics.ts elsewhere in this same session.
  new client.Gauge({
    name: 'open5gs_cdr_calls_total', help: 'Call count from nms_cdr (PSTN Gateway + Asterisk-2G only — direct IMS-to-IMS calls are intentionally excluded, see the IMS/VoLTE dashboard for those) by instance, disposition, and trailing window',
    labelNames: ['cdr_instance', 'disposition', 'window'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const c of s.calls) this.set({ cdr_instance: c.instance, disposition: c.disposition, window: c.window }, c.count);
    },
  });

  new client.Gauge({
    name: 'open5gs_cdr_talk_seconds_sum', help: 'Sum of durationSeconds over answered calls only (never all dispositions — unanswered calls store a real 0, not null, which would silently skew this) by instance and trailing window',
    labelNames: ['cdr_instance', 'window'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const t of s.talkTime) this.set({ cdr_instance: t.instance, window: t.window }, t.sumSeconds);
    },
  });

  new client.Gauge({
    name: 'open5gs_cdr_talk_seconds_avg', help: 'Average durationSeconds over answered calls only (see open5gs_cdr_talk_seconds_sum\'s own help text for why the disposition filter matters) by instance and trailing window',
    labelNames: ['cdr_instance', 'window'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const t of s.talkTime) this.set({ cdr_instance: t.instance, window: t.window }, t.avgSeconds);
    },
  });

  new client.Gauge({
    name: 'open5gs_cdr_pstn_trunk_type_calls_total', help: 'PSTN Gateway call count by trunk type (internal short-code/MSISDN dialing vs. real external-DID) and trailing window — PSTN-only, trunkType is not populated for Asterisk-2G/IMS rows',
    labelNames: ['trunk_type', 'window'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const t of s.trunkTypeCalls) this.set({ trunk_type: t.trunkType, window: t.window }, t.count);
    },
  });

  return registry;
}
