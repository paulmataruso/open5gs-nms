import * as client from 'prom-client';
import { OcsReservationGuard } from './ocs-reservation-guard';

/**
 * Exposes OcsReservationGuard's own sweep bookkeeping (ocs-reservation-
 * guard.ts's getStats()) as Prometheus metrics — zero new RPC cost, since
 * the guard already runs its 30-minute sweep unconditionally and this only
 * reads numbers it already computed. Same sibling-registry pattern as every
 * other registry in this codebase; collect() never does I/O.
 *
 * open5gs_ocs_reservation_guard_cleared_total resets on an NMS BACKEND
 * restart (it's an in-process counter, not persisted) — a third, distinct
 * reset trigger from ocs-metrics.ts's own Diameter-answer Gauges (which
 * reset on peer reconnect) and every daemon-backed Gauge elsewhere in this
 * codebase (which reset on THAT daemon's own restart). Prometheus itself
 * (already the durable long-term store per CLAUDE.md pattern #12) is the
 * correct way to get true pre-restart history via increase(), matching how
 * this project already reasons about every other Gauge reset.
 */
export function createOcsReservationGuardMetricsRegistry(guard: OcsReservationGuard): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_sweeps_total', help: 'Cumulative sweep attempts since this NMS backend process started (resets on backend restart, not OCS restart)',
    registers: [registry],
    collect() { this.set(guard.getStats().sweepsRun); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_last_sweep_success', help: '1 if the most recent sweep completed without error, 0 otherwise',
    registers: [registry],
    collect() { this.set(guard.getStats().lastSweepSuccess ? 1 : 0); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_last_sweep_timestamp_seconds', help: 'Unix timestamp (seconds) of the most recent sweep attempt, 0 if never run',
    registers: [registry],
    collect() { const s = guard.getStats(); this.set(s.lastSweepAt ? Math.floor(s.lastSweepAt / 1000) : 0); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_last_sweep_cleared', help: 'Stuck reservations cleared by the most recent sweep',
    registers: [registry],
    collect() { this.set(guard.getStats().lastSweepClearedCount); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_last_sweep_buckets_affected', help: 'Buckets that had at least one stuck reservation cleared by the most recent sweep',
    registers: [registry],
    collect() { this.set(guard.getStats().lastSweepBucketsAffected); },
  });

  new client.Gauge({
    name: 'open5gs_ocs_reservation_guard_cleared_total', help: 'Cumulative stuck reservations cleared since this NMS backend process started (resets on backend restart — see this file\'s own header comment)',
    registers: [registry],
    collect() { this.set(guard.getStats().totalCleared); },
  });

  return registry;
}
