/**
 * Kamailio Prometheus exporter — same sibling-registry pattern as this
 * project's other three (traffic-history/twamp/gsm). collect() only ever
 * reads KamailioStatsMonitor's in-memory cache — never runs kamcmd itself —
 * same reasoning as every other sibling registry: index.ts's single
 * /metrics handler awaits every registry's metrics() in one response.
 *
 * Gauge, never Counter, for every metric here — confirmed against the
 * actually-installed prom-client (v15.1.3): Counter has no .set() at all,
 * only .inc(), which throws on a negative delta. These are Kamailio's own
 * process-lifetime counters (kamcmd stats.get_statistics), which reset to 0
 * on every `kamailio-<role>` restart (a real, frequent event in this
 * project — every IMS Configure click restarts these processes) — Gauge.
 * set() has no such restriction, and a sudden drop toward 0 after a
 * restart is the ACCURATE representation, not a bug to work around.
 *
 * open5gs_ims_kamailio_up{role} is the standard Prometheus "is this target
 * alive" idiom — without it, one instance going down would just look like
 * its own numbers flatlining rather than visibly going stale.
 *
 * No `sum()` across the role label is meaningful for the SIP request/reply
 * counters — see this file's own dashboard companion (ims.json) for why:
 * one logical transaction (e.g. a REGISTER) is counted once by EACH
 * instance it legitimately passes through (P-CSCF -> I-CSCF -> S-CSCF), so
 * summing would triple-count it. Any "how many total X" single-number
 * panel should read one specific, authoritative role's own counter (this
 * project's own call-stats-monitor.ts already established the precedent:
 * it reads dialog/SMS totals from S-CSCF specifically, never summed).
 */

import * as client from 'prom-client';
import { KamailioStatsMonitor, KamailioRole, KAMAILIO_ROLES } from './kamailio-stats-monitor';

export function createImsKamailioMetricsRegistry(monitor: KamailioStatsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_ims_kamailio_up', help: '1 if the last kamcmd stats query against this Kamailio instance succeeded, 0 otherwise',
    labelNames: ['role'], registers: [registry],
    collect() {
      for (const role of KAMAILIO_ROLES) this.set({ role }, monitor.getLatest().get(role)?.up ? 1 : 0);
    },
  });

  // One value per role, straightforward "group:name" -> value. `pick`
  // returns the raw stat key to read for a given role, or undefined to
  // skip that role for this metric entirely (e.g. pike:blocked_ips only
  // exists on I-CSCF — the label combination for pcscf/scscf/smsc simply
  // never appears, which is correct: a metric a role doesn't emit at all
  // is a materially different fact from that role reporting a real 0).
  const roleGauge = (name: string, help: string, pick: (role: KamailioRole) => string | undefined) => {
    new client.Gauge({
      name, help, labelNames: ['role'], registers: [registry],
      collect() {
        // Real, confirmed-live 2026-09-29 finding (full-session wiring audit): without
        // this reset(), a role that goes down (a real, frequent event — every IMS
        // Configure click restarts these processes) just keeps reporting its last-known
        // value forever instead of a gap. Same staleness bug class already fixed for
        // TWAMP/OCS/GSM elsewhere in this same session.
        this.reset();
        for (const role of KAMAILIO_ROLES) {
          const stats = monitor.getLatest().get(role);
          if (!stats?.up) continue;
          const key = pick(role);
          if (!key) continue;
          const v = stats.values.get(key);
          if (v !== undefined) this.set({ role }, v);
        }
      },
    });
  };

  // Multi-role x one extra label (SIP method, reply class, etc.). `entries`
  // lists every (role, labelValue, rawKey) combination that's meaningful —
  // deliberately explicit rather than a cross-product, since e.g. I-CSCF
  // has no dialog_ng group at all and SMSC's SIP method mix is different
  // from the other three's.
  const roleLabeledGauge = (
    name: string, help: string, extraLabel: string,
    entries: Array<{ role: KamailioRole; label: string; rawKey: string }>,
  ) => {
    new client.Gauge({
      name, help, labelNames: ['role', extraLabel], registers: [registry],
      collect() {
        this.reset(); // same staleness fix as roleGauge() above
        for (const e of entries) {
          const stats = monitor.getLatest().get(e.role);
          if (!stats?.up) continue;
          const v = stats.values.get(e.rawKey);
          if (v !== undefined) this.set({ role: e.role, [extraLabel]: e.label }, v);
        }
      },
    });
  };

  // ── Cross-role (present on all 4 instances) ──────────────────────────
  roleGauge('open5gs_ims_kamailio_diameter_avg_response_time_ms', 'cdp module average Diameter response time (milliseconds)', () => 'cdp:average_response_time');
  roleGauge('open5gs_ims_kamailio_diameter_replies_total', 'Cumulative Diameter replies received via cdp (resets to 0 on restart)', () => 'cdp:replies_received');
  roleGauge('open5gs_ims_kamailio_diameter_timeouts_total', 'Cumulative Diameter timeouts via cdp (resets to 0 on restart)', () => 'cdp:timeout');
  roleGauge('open5gs_ims_kamailio_diameter_queue_length', 'Current cdp outbound queue length', () => 'cdp:queuelength');
  roleGauge('open5gs_ims_kamailio_shmem_used_bytes', 'Kamailio shared memory currently in use', () => 'shmem:used_size');
  roleGauge('open5gs_ims_kamailio_shmem_total_bytes', 'Kamailio shared memory pool size', () => 'shmem:total_size');
  roleGauge('open5gs_ims_kamailio_dns_failures_total', 'Cumulative failed DNS resolutions (resets to 0 on restart) — see CLAUDE.md gotcha #6/#18 for the real "DNS or die" incident class this detects', () => 'dns:failed_dns_request');
  roleGauge('open5gs_ims_kamailio_mysql_driver_errors_total', 'Cumulative MySQL driver errors (resets to 0 on restart)', () => 'mysql:driver_errors');
  roleGauge('open5gs_ims_kamailio_blocked_ips', 'IPs currently blocked by the pike flood-protection module (only loaded on I-CSCF today)', role => (role === 'icscf' ? 'pike:blocked_ips' : undefined));
  roleGauge('open5gs_ims_kamailio_transactions_active', 'Currently active SIP transactions (tmx module)', () => 'tmx:active_transactions');

  roleLabeledGauge('open5gs_ims_kamailio_sip_requests_total', 'Cumulative SIP requests received by method (resets to 0 on restart)', 'method',
    (['pcscf', 'icscf', 'scscf', 'smsc'] as KamailioRole[]).flatMap(role =>
      ['register', 'invite', 'bye', 'cancel', 'message', 'subscribe', 'notify', 'options', 'prack', 'update', 'refer', 'publish', 'info', 'ack']
        .map(method => ({ role, label: method, rawKey: `core:rcv_requests_${method}` }))));

  roleLabeledGauge('open5gs_ims_kamailio_sip_replies_total', 'Cumulative SIP replies received by class (resets to 0 on restart)', 'class',
    (['pcscf', 'icscf', 'scscf', 'smsc'] as KamailioRole[]).flatMap(role =>
      ['1xx', '2xx', '3xx', '4xx', '5xx', '6xx'].map(cls => ({ role, label: cls, rawKey: `core:rcv_replies_${cls}` }))));

  roleLabeledGauge('open5gs_ims_kamailio_sip_replies_by_code_total', 'Cumulative SIP replies received by exact response code, for codes worth watching individually (resets to 0 on restart)', 'code',
    (['pcscf', 'icscf', 'scscf', 'smsc'] as KamailioRole[]).flatMap(role =>
      ['401', '404', '407', '480', '486'].map(code => ({ role, label: code, rawKey: `core:rcv_replies_${code}` }))));

  roleLabeledGauge('open5gs_ims_kamailio_transactions_total', 'Cumulative SIP transactions by final class (tmx module, resets to 0 on restart)', 'class',
    (['pcscf', 'icscf', 'scscf', 'smsc'] as KamailioRole[]).flatMap(role =>
      ['2xx', '3xx', '4xx', '5xx', '6xx'].map(cls => ({ role, label: cls, rawKey: `tmx:${cls}_transactions` }))));

  // ── Dialogs (only pcscf/scscf load dialog_ng — icscf is stateless routing, no dialogs) ──
  roleGauge('open5gs_ims_kamailio_dialogs_active', 'Currently active SIP dialogs (calls in progress)', role => (role === 'pcscf' || role === 'scscf' ? 'dialog_ng:active' : undefined));
  roleGauge('open5gs_ims_kamailio_dialogs_processed_total', 'Cumulative dialogs processed since process start (resets to 0 on restart)', role => (role === 'pcscf' || role === 'scscf' ? 'dialog_ng:processed' : undefined));

  // ── Registrations — semantically the same fact, different raw key per role ──
  roleGauge('open5gs_ims_kamailio_registered_contacts', 'Currently registered contacts', role => {
    if (role === 'pcscf') return 'ims_usrloc_pcscf:registered_contacts';
    if (role === 'scscf') return 'ims_usrloc_scscf:active_contacts';
    return undefined;
  });
  roleGauge('open5gs_ims_kamailio_registered_impus', 'Currently registered/active IMPUs (public user identities)', role => {
    if (role === 'pcscf') return 'ims_usrloc_pcscf:registered_impus';
    if (role === 'scscf') return 'ims_usrloc_scscf:active_impus';
    return undefined;
  });
  roleGauge('open5gs_ims_kamailio_registration_success_total', 'Cumulative successful registrations (resets to 0 on restart)', role => {
    if (role === 'pcscf') return 'script:register_success';
    if (role === 'scscf') return 'ims_registrar_scscf:accepted_regs';
    return undefined;
  });
  roleGauge('open5gs_ims_kamailio_registration_failed_total', 'Cumulative failed/rejected registrations (resets to 0 on restart)', role => {
    if (role === 'pcscf') return 'script:register_failed';
    if (role === 'scscf') return 'ims_registrar_scscf:rejected_regs';
    return undefined;
  });
  roleGauge('open5gs_ims_kamailio_registration_avg_response_time_ms', 'Average SAR (Server-Assignment-Request, Cx) response time for registration — S-CSCF only', role => (role === 'scscf' ? 'ims_registrar_scscf:sar_avg_response_time' : undefined));

  // ── Cx auth (I-CSCF's own view) ──
  roleGauge('open5gs_ims_kamailio_cx_lir_total', 'Cumulative Cx LIR (Location-Info-Request) replies received — I-CSCF only (resets to 0 on restart)', role => (role === 'icscf' ? 'ims_icscf:lir_replies_received' : undefined));
  roleGauge('open5gs_ims_kamailio_cx_uar_total', 'Cumulative Cx UAR (User-Authorization-Request) replies received — I-CSCF only (resets to 0 on restart)', role => (role === 'icscf' ? 'ims_icscf:uar_replies_received' : undefined));
  roleGauge('open5gs_ims_kamailio_cx_mar_total', 'Cumulative Cx MAR (Multimedia-Auth-Request) replies received — S-CSCF only (resets to 0 on restart)', role => (role === 'scscf' ? 'ims_auth:mar_replies_received' : undefined));

  // ── Rx interface (P-CSCF <-> PCRF) — see CLAUDE.md pattern #13 (dedicated QCI=1 bearer feature) ──
  roleGauge('open5gs_ims_kamailio_rx_registration_sessions_active', 'Active Rx registration sessions (P-CSCF only) — pattern #13\'s dedicated QCI=1 bearer feature', role => (role === 'pcscf' ? 'ims_qos:active_registration_rx_sessions' : undefined));
  roleGauge('open5gs_ims_kamailio_rx_media_sessions_active', 'Active Rx media (dedicated bearer) sessions (P-CSCF only)', role => (role === 'pcscf' ? 'ims_qos:active_media_rx_sessions' : undefined));
  roleLabeledGauge('open5gs_ims_kamailio_rx_aar_total', 'Cumulative Rx AAR (AA-Request) attempts by type and result — P-CSCF only (resets to 0 on restart)', 'type',
    [
      { role: 'pcscf' as KamailioRole, label: 'registration_success', rawKey: 'ims_qos:successful_registration_aars' },
      { role: 'pcscf' as KamailioRole, label: 'registration_failed', rawKey: 'ims_qos:failed_registration_aars' },
      { role: 'pcscf' as KamailioRole, label: 'media_success', rawKey: 'ims_qos:successful_media_aars' },
      { role: 'pcscf' as KamailioRole, label: 'media_failed', rawKey: 'ims_qos:failed_media_aars' },
    ]);

  // ── Ro voice charging (S-CSCF's own side only — OCS/Erlang-side rating
  // engine internals are explicitly out of scope, see ims.json's own note
  // on this row pointing operators at OCS's own GUI for balance/rating) ──
  roleGauge('open5gs_ims_kamailio_ro_sessions_active', 'Active Ro (voice charging) sessions — S-CSCF only', role => (role === 'scscf' ? 'ims_charging:active_ro_sessions' : undefined));
  roleGauge('open5gs_ims_kamailio_ro_billed_seconds_total', 'Cumulative billed seconds since process start — S-CSCF only (resets to 0 on restart)', role => (role === 'scscf' ? 'ims_charging:billed_secs' : undefined));
  roleGauge('open5gs_ims_kamailio_ro_ccr_avg_response_time_ms', 'Average CCR (Credit-Control-Request) response time — S-CSCF only', role => (role === 'scscf' ? 'ims_charging:ccr_avg_response_time' : undefined));
  roleGauge('open5gs_ims_kamailio_ro_ccr_timeouts_total', 'Cumulative CCR timeouts — S-CSCF only (resets to 0 on restart)', role => (role === 'scscf' ? 'ims_charging:ccr_timeouts' : undefined));
  roleLabeledGauge('open5gs_ims_kamailio_ro_ccr_total', 'Cumulative CCRs by type and result — S-CSCF only (resets to 0 on restart)', 'type',
    (['initial', 'interim', 'final'] as const).flatMap(kind => ([
      { role: 'scscf' as KamailioRole, label: `${kind}_success`, rawKey: `ims_charging:successful_${kind}_ccrs` },
      { role: 'scscf' as KamailioRole, label: `${kind}_failed`, rawKey: `ims_charging:failed_${kind}_ccrs` },
    ])));

  return registry;
}
