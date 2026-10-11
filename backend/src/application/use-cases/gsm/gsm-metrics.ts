/**
 * 2G UE Signal Prometheus exporter — same reasoning as
 * traffic-history/prometheus-metrics.ts and twamp/twamp-metrics.ts: reuse
 * the existing Prometheus+Grafana stack (already scraping this backend's own
 * /metrics) instead of building a dedicated exporter for a third data
 * source. Reads gsm-controller.ts's own background-refreshed cache
 * (getCachedGsmSignalSamples) — collect() must never do the live
 * `nsenter sqlite3` query itself, since index.ts's single /metrics handler
 * awaits every registered registry's metrics() in one response; a slow
 * meas.db query here would add latency (or blow the 10s scrape_timeout) for
 * the unrelated Traffic History/TWAMP gauges sharing that same response.
 *
 * Every gauge calls reset() before repopulating — unlike prometheus-
 * metrics.ts/twamp-metrics.ts's gauges, whose label sets (dnn, imsi of a
 * provisioned subscriber, twamp target) are effectively stable. 2G UEs
 * routinely go idle/detach, and getCachedGsmSignalSamples() is already
 * filtered (in gsm-controller.ts) to only currently-connected IMSIs — reset()
 * is what turns "no longer in that list" into "the series actually
 * disappears from this scrape" instead of a stale-but-plausible reading
 * lingering forever.
 */

import * as client from 'prom-client';
import { getCachedGsmSignalSamples, CachedGsmSignalSample } from '../../../interfaces/rest/gsm-controller';

export function createGsmMetricsRegistry(): client.Registry {
  const registry = new client.Registry();

  // Real, 2026-09-25 finding (adversarial review): prom-client's
  // Registry.merge() throws synchronously on a metric-name collision across
  // registries (index.ts's /metrics handler would then 500 — killing
  // Traffic History and TWAMP's metrics too, not just these). Every name
  // below is scoped under the open5gs_gsm2g_ prefix — confirmed at review
  // time via a repo-wide grep that no existing metric (in this file's two
  // siblings, or anywhere else) uses it.
  const numberGauge = (
    name: string, help: string,
    pick: (r: CachedGsmSignalSample) => number | null,
  ) => {
    new client.Gauge({
      name, help, labelNames: ['imsi', 'bts'], registers: [registry],
      collect() {
        this.reset();
        for (const r of getCachedGsmSignalSamples()) {
          const v = pick(r);
          if (v !== null) this.set({ imsi: r.imsi, bts: String(r.bts) }, v);
        }
      },
    });
  };

  numberGauge('open5gs_gsm2g_ul_rxlev_dbm', 'Uplink RxLev (full), as heard by the BTS from the MS', r => r.ulRxLevDbm);
  numberGauge('open5gs_gsm2g_dl_rxlev_dbm', 'Downlink RxLev (full), as heard by the MS from the BTS', r => r.dlRxLevDbm);
  numberGauge('open5gs_gsm2g_ul_rxqual', 'Uplink RxQual (full), 0 (best) to 7 (worst)', r => r.ulRxQual);
  numberGauge('open5gs_gsm2g_dl_rxqual', 'Downlink RxQual (full), 0 (best) to 7 (worst)', r => r.dlRxQual);
  numberGauge('open5gs_gsm2g_ms_power_dbm', 'MS (handset) transmit power', r => r.msPowerDbm);
  numberGauge('open5gs_gsm2g_bs_power_dbm', 'BTS transmit power', r => r.bsPowerDbm);
  numberGauge('open5gs_gsm2g_timing_advance', 'Timing advance, in bit periods (~550m per step)', r => r.timingAdvance);
  numberGauge('open5gs_gsm2g_ul_path_loss_db', 'Uplink path loss (MS transmit power minus BTS RxLev)', r => r.ulPathLossDb);
  numberGauge('open5gs_gsm2g_dl_path_loss_db', 'Downlink path loss (BTS transmit power minus MS RxLev)', r => r.dlPathLossDb);

  // Standard Prometheus "info metric" idiom (e.g. kube_pod_info) — keeps
  // mutable identity fields (nickname/msisdn can be edited by an operator)
  // off the 9 numeric gauges' own label sets. Putting a mutable value on a
  // gauge's own labels would leave an orphaned zombie series behind every
  // time it changed, since prom-client never garbage-collects a label
  // combination on its own; Grafana can instead LEFT JOIN this in via
  // `* on(imsi) group_left(nickname, msisdn) open5gs_gsm2g_subscriber_info`.
  new client.Gauge({
    name: 'open5gs_gsm2g_subscriber_info',
    help: 'Always 1 — carries nickname/msisdn as labels for a Grafana join against the numeric gauges, keyed on imsi',
    labelNames: ['imsi', 'nickname', 'msisdn'],
    registers: [registry],
    collect() {
      this.reset();
      for (const r of getCachedGsmSignalSamples()) {
        this.set({ imsi: r.imsi, nickname: r.nickname ?? '', msisdn: r.msisdn ?? '' }, 1);
      }
    },
  });

  return registry;
}
