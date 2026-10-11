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
      // Real bug, found 2026-09-26 building the Traffic History dashboard
      // (critic review): prom-client Gauges only ever mutate additively via
      // .set() — a DNN/IMSI this collect() doesn't see on a given scrape
      // (a removed UPF tun device, or a subscriber whose session IP was
      // reassigned — CLAUDE.md architectural pattern #11 documents IP
      // reassignment as routine, designed-for behavior in this exact
      // system) keeps its LAST value frozen here forever, not a gap, since
      // nothing ever calls .remove()/.reset(). Same bug class as TWAMP's
      // own pre-fix Gauge staleness — reset() before repopulating is what
      // turns "no longer present" into the series actually disappearing.
      this.reset();
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
      this.reset();
      const counters = await gtpBandwidthMonitor.getRawCounters();
      for (const c of counters) this.set({ dnn: c.dnn }, c.txBytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_gtp_rx_packets_total',
    help: 'Cumulative uplink (UE upload) packet count per DNN, from the UPF tun device rx counter — real proxy for Open5GS\'s own fivegs_ep_n3_gtp_indatapktn3upf, which is never populated by this build (see open5gs/open5gs#3100)',
    labelNames: ['dnn'],
    registers: [registry],
    async collect() {
      this.reset();
      const counters = await gtpBandwidthMonitor.getRawPacketCounters();
      for (const c of counters) this.set({ dnn: c.dnn }, c.rxPackets);
    },
  });

  new client.Gauge({
    name: 'open5gs_gtp_tx_packets_total',
    help: 'Cumulative downlink (UE download) packet count per DNN, from the UPF tun device tx counter — real proxy for Open5GS\'s own fivegs_ep_n3_gtp_outdatapktn3upf, which is never populated by this build (see open5gs/open5gs#3100)',
    labelNames: ['dnn'],
    registers: [registry],
    async collect() {
      this.reset();
      const counters = await gtpBandwidthMonitor.getRawPacketCounters();
      for (const c of counters) this.set({ dnn: c.dnn }, c.txPackets);
    },
  });

  new client.Gauge({
    name: 'open5gs_subscriber_up_bytes_total',
    help: 'Cumulative uplink bytes per subscriber IMSI, from nftables counters (subscriber-ip-accounting.ts)',
    labelNames: ['imsi'],
    registers: [registry],
    async collect() {
      this.reset();
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
      this.reset();
      const counters = await subscriberIpAccounting.readCounters();
      for (const c of counters) this.set({ imsi: c.imsi }, c.downBytes);
    },
  });

  return registry;
}
