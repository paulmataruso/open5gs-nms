/**
 * Traffic History Prometheus exporter.
 *
 * This project already runs Prometheus + Grafana (monitoring/prometheus.yml,
 * managed by SyncPrometheusConfigUseCase) with 30-day retention, scraping
 * every Open5GS NF's own metrics endpoint. Rather than building a second,
 * bespoke time-series store, Traffic History exposes its data the same way —
 * a `/metrics` endpoint the existing Prometheus instance scrapes — and lets
 * Prometheus own storage/retention/rate-computation entirely.
 *
 * Each Gauge below is set to the CURRENT cumulative counter value read fresh
 * on every scrape (`collect()` callback) — not a locally-computed rate. This
 * is deliberate: exposing raw ever-increasing counters and letting PromQL's
 * `rate()`/`increase()` compute Mbps at query time is the idiomatic
 * Prometheus pattern, and avoids this codebase reimplementing what
 * Prometheus already does well.
 */

import * as client from 'prom-client';
import { GtpBandwidthMonitor } from '../interface-status/gtp-bandwidth';
import { SubscriberIpAccounting } from './subscriber-ip-accounting';

export function createTrafficMetricsRegistry(
  gtpBandwidthMonitor: GtpBandwidthMonitor,
  subscriberIpAccounting: SubscriberIpAccounting,
): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_gtp_rx_bytes_total',
    help: 'Cumulative uplink (UE upload) bytes per DNN, from the UPF tun device rx counter',
    labelNames: ['dnn'],
    registers: [registry],
    async collect() {
      const counters = await gtpBandwidthMonitor.getRawCounters();
      for (const c of counters) this.set({ dnn: c.dnn }, c.rxBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_gtp_tx_bytes_total',
    help: 'Cumulative downlink (UE download) bytes per DNN, from the UPF tun device tx counter',
    labelNames: ['dnn'],
    registers: [registry],
    async collect() {
      const counters = await gtpBandwidthMonitor.getRawCounters();
      for (const c of counters) this.set({ dnn: c.dnn }, c.txBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_subscriber_up_bytes_total',
    help: 'Cumulative uplink bytes per subscriber IMSI, from nftables counters (subscriber-ip-accounting.ts)',
    labelNames: ['imsi'],
    registers: [registry],
    async collect() {
      const counters = await subscriberIpAccounting.readCounters();
      for (const c of counters) this.set({ imsi: c.imsi }, c.upBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_subscriber_down_bytes_total',
    help: 'Cumulative downlink bytes per subscriber IMSI, from nftables counters (subscriber-ip-accounting.ts)',
    labelNames: ['imsi'],
    registers: [registry],
    async collect() {
      const counters = await subscriberIpAccounting.readCounters();
      for (const c of counters) this.set({ imsi: c.imsi }, c.downBytes);
    },
  });

  return registry;
}
