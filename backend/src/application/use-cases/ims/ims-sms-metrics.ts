import * as client from 'prom-client';
import { ImsCallStatsMonitor } from './call-stats-monitor';

/**
 * SMS-side metrics for the SMS/MMS dashboard. Both Gauges below are
 * deliberately wrapped in their own try/catch, even where the underlying
 * source is already known-safe (ImsCallStatsMonitor.getLatest() always
 * returns a real object, never throws) — critic review flagged that
 * index.ts's single /metrics handler wraps ALL registries in one try/catch
 * with no per-registry isolation, so any thrown exception here would take
 * every OTHER feature's metrics down too (Traffic History, TWAMP, OCS, CDR,
 * GSM, radio-info), not just this one. Catching locally and skipping/
 * defaulting is required, not optional, for any new registry added to this
 * shared endpoint.
 */
export function createImsSmsMetricsRegistry(callStatsMonitor: ImsCallStatsMonitor, getSmsDeliveryMode: () => 'sgs' | 'ims' | 'vectorcore'): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_ims_total_sms_sent',
    help: 'All-time SIP MESSAGE requests S-CSCF has received, across every delivery mode and kamailio-scscf restart',
    registers: [registry],
    collect() {
      try {
        this.set(callStatsMonitor.getLatest().totalSmsSent);
      } catch {
        // Never let a scrape-time failure here take down every other
        // registry sharing this same /metrics response.
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_sms_delivery_mode',
    help: 'Which SMS delivery path is currently active: 0=ims (inline SMSC), 1=sgs (2G/Osmocom), 2=vectorcore. Always set every scrape (defaults to 0 if IMS isn\'t configured yet) — there is no meaningful "absence" state for this gauge, matching getSmsDeliveryMode()\'s own safe-default contract.',
    registers: [registry],
    collect() {
      try {
        const mode = getSmsDeliveryMode();
        this.set(mode === 'sgs' ? 1 : mode === 'vectorcore' ? 2 : 0);
      } catch {
        this.set(0);
      }
    },
  });

  return registry;
}
