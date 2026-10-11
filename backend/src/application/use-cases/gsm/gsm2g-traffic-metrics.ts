import * as client from 'prom-client';
import { getCachedGprsTrafficByImsi, getGgsnTunCounters } from '../../../interfaces/rest/gsm-controller';

/**
 * 2G GPRS/EDGE traffic Prometheus exporter — same reasoning as
 * traffic-history/prometheus-metrics.ts: reuse the existing Prometheus+
 * Grafana stack instead of a bespoke store. Deliberately separate metric
 * names from the 4G/5G open5gs_gtp_ / open5gs_subscriber_ families — see
 * getGgsnTunCounters()'s own comment for why reusing those names (both
 * this deployment's GGSN APN and Open5GS's DNN happen to be named
 * "internet") would silently clobber one side's counter, not sum them.
 */
export function createGsm2gTrafficMetricsRegistry(): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_gsm2g_gtp_rx_bytes_total',
    help: 'Cumulative uplink (MS upload) bytes for GPRS/EDGE data, from the GGSN tun device rx counter, by APN',
    labelNames: ['apn'],
    registers: [registry],
    async collect() {
      this.reset();
      const c = await getGgsnTunCounters();
      if (c) this.set({ apn: c.apn }, c.rxBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_gsm2g_gtp_tx_bytes_total',
    help: 'Cumulative downlink (MS download) bytes for GPRS/EDGE data, from the GGSN tun device tx counter, by APN',
    labelNames: ['apn'],
    registers: [registry],
    async collect() {
      this.reset();
      const c = await getGgsnTunCounters();
      if (c) this.set({ apn: c.apn }, c.txBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_gsm2g_subscriber_up_bytes_total',
    help: 'Cumulative uplink bytes per 2G subscriber IMSI, from osmo-sgsn\'s own per-PDP-context accounting',
    labelNames: ['imsi', 'bts'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of getCachedGprsTrafficByImsi()) this.set({ imsi: r.imsi, bts: String(r.bts ?? '') }, r.upBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_gsm2g_subscriber_down_bytes_total',
    help: 'Cumulative downlink bytes per 2G subscriber IMSI, from osmo-sgsn\'s own per-PDP-context accounting',
    labelNames: ['imsi', 'bts'],
    registers: [registry],
    async collect() {
      this.reset();
      for (const r of getCachedGprsTrafficByImsi()) this.set({ imsi: r.imsi, bts: String(r.bts ?? '') }, r.downBytes);
    },
  });

  return registry;
}
