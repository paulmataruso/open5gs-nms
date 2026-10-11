import * as client from 'prom-client';
import { SgsSmsMetricsMonitor } from './sgs-sms-metrics-monitor';

/**
 * SMS-over-SGs (osmo-msc's own inline SMSC, /sms.db) metrics — a live queue
 * snapshot, not a delivery-history trend. Both Gauges wrapped defensively
 * (see ims-sms-metrics.ts's own header comment for why: index.ts's single
 * /metrics handler has no per-registry failure isolation).
 */
export function createSgsSmsMetricsRegistry(monitor: SgsSmsMetricsMonitor): client.Registry {
  const registry = new client.Registry();

  new client.Gauge({
    name: 'open5gs_sgs_sms_up',
    help: '1 if the last read of osmo-msc\'s own SMS queue (/sms.db) succeeded',
    registers: [registry],
    collect() {
      try {
        this.set(monitor.getLatest().up ? 1 : 0);
      } catch {
        this.set(0);
      }
    },
  });

  new client.Gauge({
    name: 'open5gs_sgs_sms_queue_total',
    help: 'Messages in osmo-msc\'s local SMS queue by status (delivered/pending/expired) — a live snapshot, not historical volume',
    labelNames: ['status'],
    registers: [registry],
    collect() {
      try {
        this.reset();
        const { counts } = monitor.getLatest();
        for (const status of Object.keys(counts) as Array<keyof typeof counts>) {
          this.set({ status }, counts[status]);
        }
      } catch {
        // Skip this scrape rather than take down every other registry.
      }
    },
  });

  return registry;
}
