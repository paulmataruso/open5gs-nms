import * as client from 'prom-client';
import { RadioSessionCache } from './radio-session-cache';
import { getCachedGprsTrafficByImsi } from '../../../interfaces/rest/gsm-controller';

export interface RadioNameLookup {
  (radioIp: string): string | undefined;
}

/**
 * Shared radio-identity gauge backing BOTH the Traffic History radio filter
 * and the RAN-type (2G/4G/5G) filter, for the web module and Grafana alike:
 *
 *   open5gs_radio_info{imsi, radio_ip, radio_name, ran_generation} = 1
 *
 * Real bug, caught in critic review before this shipped (2026-09-26): the
 * generation dimension is named `ran_generation`, NOT `generation` — this
 * deployment's Prometheus scrape config attaches a job-level static label
 * literally named `generation` (sync-prometheus-config.ts, value
 * "traffic-history" — a historical accident, not a real filter dimension)
 * to EVERY series scraped from this backend. A metric-level label sharing
 * that name would silently lose the collision under this deployment's
 * honor_labels:false scrape config — Prometheus renames the exporter's own
 * value to exported_generation and overwrites `generation` with the job's
 * static "traffic-history" value, making a `generation=~"$ran_type"` filter
 * either a permanent no-op or permanently empty. Exact same collision class
 * already found and fixed once this session (asterisk-metrics.ts/
 * cdr-metrics.ts's own `instance` label vs Prometheus's own reserved
 * scrape-target label) — `ran_generation` avoids it entirely.
 *
 * Populated from TWO independently-timed sources (a 4G/5G session cache
 * wrapping active-sessions.ts, and 2G's own SGSN-derived per-subscriber
 * cache in gsm-controller.ts) — this is safe because the two populate
 * genuinely disjoint label combinations (a dual-attached subscriber
 * correctly produces two separate rows, one per generation), NOT because
 * either gates the other's freshness the way the 2G signal dashboard's own
 * pre-fix bug did. The one real risk here, avoided deliberately: reset()
 * must be called exactly ONCE at the top of collect(), before EITHER source
 * populates — calling it once per source (the natural mistake, matching
 * gsm-metrics.ts's own per-gauge reset() idiom) would wipe whichever
 * generation's rows were set first, on every single scrape, deterministically.
 *
 * `radio_ip` is left EMPTY for 2G rows rather than a synthetic non-IP value
 * — the join/filter machinery here only ever needs `radio_name` +
 * `ran_generation`, and a label literally named `radio_ip` holding a BTS
 * UUID would be confusing noise in any table/legend that renders it, and a
 * silent non-match trap for a future query author typing a real IP.
 */
export function createRadioInfoMetricsRegistry(radioSessionCache: RadioSessionCache, getRadioName: RadioNameLookup): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_radio_info',
    help: 'Always 1 — carries which radio (and RAN generation) a subscriber is currently on, for joining against traffic gauges by imsi. See this file\'s own header comment for the ran_generation naming and the single-reset discipline this collect() depends on.',
    labelNames: ['imsi', 'radio_ip', 'radio_name', 'ran_generation'],
    registers: [registry],
    collect() {
      this.reset();

      for (const r of radioSessionCache.getLatest()) {
        this.set({ imsi: r.imsi, radio_ip: r.radioIp, radio_name: getRadioName(r.radioIp) ?? r.radioIp, ran_generation: r.generation }, 1);
      }

      for (const r of getCachedGprsTrafficByImsi()) {
        if (!r.radioName) continue;
        this.set({ imsi: r.imsi, radio_ip: '', radio_name: r.radioName, ran_generation: '2g' }, 1);
      }
    },
  });

  return registry;
}
