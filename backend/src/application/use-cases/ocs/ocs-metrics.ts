import * as client from 'prom-client';
import { OcsStatsMonitor } from './ocs-stats-monitor';

/**
 * SigScale OCS Prometheus exporter — same sibling-registry pattern as this
 * project's other four (traffic-history/twamp/gsm/ims-kamailio+rtpengine).
 * collect() only ever reads OcsStatsMonitor's in-memory cache — never RPCs
 * the Erlang node itself — same reasoning as every other sibling registry:
 * index.ts's single /metrics handler awaits every registry's metrics() in
 * one response, so a slow collect() here would risk the scrape timeout for
 * every OTHER registry sharing that response too.
 *
 * Gauge, never Counter, for the same reason as every other registry in this
 * codebase: OCS's own Diameter-connection statistics reset on every peer
 * reconnect (not just an OCS restart — a materially more frequent trigger,
 * e.g. every `kamailio-scscf` restart), and Gauge.set() tolerates a sudden
 * drop toward 0 gracefully where Counter.inc() would throw on the implied
 * negative delta.
 *
 * Every labeled Gauge calls this.reset() at the top of collect() — same
 * staleness bug class already fixed in twamp-metrics.ts/gsm-metrics.ts,
 * found here 2026-09-29 during a full-session wiring audit: without it, a
 * label combination that stops appearing in OcsStatsMonitor's snapshot (a
 * peer that disconnects, a subscriber whose bucket goes away, OCS itself
 * going down mid-scrape-cycle) keeps reporting its last-known value forever
 * instead of a gap.
 *
 * open5gs_ocs_up / open5gs_ocs_configured are the standard "is this target
 * alive, is this feature even installed" idiom this codebase already uses
 * elsewhere (see open5gs_ims_kamailio_up) — without them, an unconfigured
 * or down OCS just looks like every other number flatlining at 0, which is
 * indistinguishable from "configured, genuinely idle."
 *
 * Deliberate scope note: only `open5gs_ocs_subscriber_balance_remaining` is
 * exposed, not a companion "cap" metric — a subscriber's configured cap
 * lives in the NMS's own `nms_charging_plans` MongoDB collection, not in
 * OCS's own bucket record (which only ever stores the current remaining
 * amount, confirmed live — no original-size field survives after the
 * bucket is created). Joining that in would pull a MongoDB dependency into
 * what is otherwise a pure OCS-RPC poller; left for a future iteration if
 * actually wanted, not silently attempted and left wrong.
 */

const UNITS = ['octets', 'seconds'] as const;

export function createOcsMetricsRegistry(monitor: OcsStatsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_ocs_configured', help: '1 if SigScale OCS has been configured on this deployment, 0 otherwise (ENABLE_OCS_MODULE defaults disabled)',
    registers: [registry],
    collect() { this.set(monitor.getLatest().configured ? 1 : 0); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_up', help: '1 if the last scheduled RPC poll against the OCS Erlang node succeeded and parsed cleanly, 0 otherwise (always 0 when open5gs_ocs_configured is 0 — no RPC is attempted at all in that case)',
    registers: [registry],
    collect() { this.set(monitor.getLatest().up ? 1 : 0); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_mnesia_table_size', help: 'Row count of an OCS Mnesia table (client/service/product/bucket/offer — deliberately excludes subscriber/user/resource/httpd_user, confirmed either always-zero or one-time-setup facts on this deployment, not operational signals)',
    labelNames: ['table'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const [table, size] of Object.entries(s.mnesiaTableSizes)) this.set({ table }, size);
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_balance_remaining_total', help: 'Sum of remain_amount across every OCS bucket of this type — note this is dominated by the "Unlimited" Charging Plan\'s deliberately huge (1,000,000 GB/min) finite cap on any deployment using it, not a meaningful "real" total by itself',
    labelNames: ['units'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const u of UNITS) this.set({ units: u }, s.balanceRemainingTotal[u]);
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_bucket_count', help: 'Count of OCS buckets of this type',
    labelNames: ['units'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const u of UNITS) this.set({ units: u }, s.bucketCount[u]);
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservations_active_total', help: 'Sum of open (unfinalized) Gy/Ro reservation entries across every bucket, any age — see open5gs_ocs_reservation_guard_* for the periodic sweep that clears entries stuck by the still-unresolved ocs_rating:charge2 crash (memory sigscale_ocs_module_progress.md)',
    registers: [registry],
    collect() { this.reset(); const s = monitor.getLatest(); if (s.up) this.set(s.reservationsActiveTotal); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_buckets_with_reservations', help: 'Count of buckets currently holding at least one open reservation',
    registers: [registry],
    collect() { this.reset(); const s = monitor.getLatest(); if (s.up) this.set(s.bucketsWithReservations); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_erlang_memory_bytes', help: 'erlang:memory/0 breakdown for the OCS node',
    labelNames: ['type'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const [type, bytes] of Object.entries(s.erlangMemoryBytes)) this.set({ type }, bytes);
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_erlang_process_count', help: 'erlang:system_info(process_count) for the OCS node — a slow upward trend here is a real leak signal worth watching given the still-open rating-engine crash history',
    registers: [registry],
    collect() { this.reset(); const s = monitor.getLatest(); if (s.up) this.set(s.erlangProcessCount); },
  });

  // service is the short form (acct/auth), stripped from OCS's own
  // ocs_diameter_{acct,auth}_service naming — auth is expected to read 0
  // permanently on this deployment (nothing registers a ConnectPeer
  // against that listener), documented in the dashboard, not hidden.
  const shortService = (svc: string) => svc.replace(/^ocs_diameter_/, '').replace(/_service$/, '');

  new client.Gauge({
    name: 'open5gs_ocs_diameter_peer_connected', help: '1 iff this Diameter peer\'s watchdog state is exactly "okay" — a peer entry only appears here while its transport connection exists (an accept-mode transport has nothing to redial, so a dropped/reconnecting peer is expected to disappear from the list entirely rather than linger with a bad state — reasoned from standard Erlang/OTP diameter semantics, not witnessed live, to avoid disrupting real IMS/voice traffic just to test it)',
    labelNames: ['service', 'peer_origin_host'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const c of s.diameterConnections) this.set({ service: shortService(c.service), peer_origin_host: c.peerOriginHost }, c.connected ? 1 : 0);
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_diameter_peer_count', help: 'Count of currently connected Diameter transports per OCS service listener',
    labelNames: ['service'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      const counts = new Map<string, number>();
      for (const c of s.diameterConnections) counts.set(c.service, (counts.get(c.service) ?? 0) + 1);
      // Explicitly zero every known service, not just ones with a live
      // connection right now — auth's permanent 0 is a real, meaningful
      // fact to show, not an absent series.
      for (const svc of new Set([...counts.keys(), 'ocs_diameter_acct_service', 'ocs_diameter_auth_service'])) {
        this.set({ service: shortService(svc) }, counts.get(svc) ?? 0);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_diameter_answers_total', help: 'OCS\'s own count of Diameter answers sent, by result code (application_id 4 = Credit-Control/Gy+Ro, command_code 272 = CCR/CCA) — resets whenever THIS peer\'s Diameter transport reconnects, not only on an OCS restart, a materially more frequent trigger than any other Gauge in this dashboard family',
    labelNames: ['service', 'peer_origin_host', 'application_id', 'command_code', 'result_code'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const a of s.diameterAnswers) {
        this.set({
          service: shortService(a.service),
          peer_origin_host: a.peerOriginHost,
          application_id: String(a.applicationId),
          command_code: String(a.commandCode),
          result_code: String(a.resultCode),
        }, a.count);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_ocs_subscriber_balance_remaining', help: 'Current remaining balance per subscriber, from OCS\'s own bucket data (cardinality bounded by real subscriber count — a product with no IMSI-shaped linked identity is skipped entirely rather than mislabeled, see this file\'s own header comment)',
    labelNames: ['imsi', 'units'], registers: [registry],
    collect() {
      this.reset();
      const s = monitor.getLatest();
      if (!s.up) return;
      for (const b of s.subscriberBalances) {
        this.set({ imsi: b.imsi, units: 'octets' }, b.dataRemaining);
        this.set({ imsi: b.imsi, units: 'seconds' }, b.voiceRemaining);
      }
    },
  });

  return registry;
}
