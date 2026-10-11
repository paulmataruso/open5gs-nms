import { Db } from 'mongodb';
import pino from 'pino';
import { CDR_COLLECTION } from './cdr-store';

/**
 * CDR-derived call-volume Prometheus exporter — reads the EXISTING
 * `nms_cdr` collection (cdr-store.ts / cdr-sync-monitor.ts, already
 * populated from PSTN Gateway's and Asterisk-2G's own CDR CSVs, plus
 * direct IMS `acc` accounting). This is a genuinely new pattern for this
 * codebase's Prometheus registries: every OTHER sibling reads a live
 * host/RPC-backed cache; this one reads a periodically-refreshed MongoDB
 * aggregation. Scoped to sourceSystem IN ('pstn','2g') only — deliberately
 * excludes 'ims'-sourced rows even though they live in the same
 * collection, since this registry backs the Asterisk-focused dashboard
 * specifically (the IMS/VoLTE dashboard already covers direct-IMS call
 * data via Kamailio's own accounting).
 *
 * Two real, live-confirmed correctness traps this file's own aggregation
 * pipeline exists specifically to avoid:
 *   1. `durationSeconds` is a real, non-null 0 (not null) for every
 *      unanswered disposition (busy/failed/cancelled/no-answer) — a naive
 *      average across ALL rows, not just `disposition:"answered"`,
 *      understates real average talk time by roughly 2x-4x (confirmed
 *      live against this deployment's real data). Every talk-time
 *      aggregation branch below explicitly matches `disposition:
 *      "answered"` first.
 *   2. Without an explicit `sourceSystem: {$in:['pstn','2g']}` filter, a
 *      dashboard titled "Asterisk / Voice Gateway" would silently grow a
 *      third, out-of-scope `instance="ims"` label series from real,
 *      sizeable IMS-sourced data living in the same collection. Applied
 *      once, in the pipeline's own outer $match, so every facet branch
 *      inherits it.
 *
 * Single aggregate() call per poll (one $facet pipeline computing both the
 * 1h and 24h windows' calls/talk-time/trunk-type breakdowns in one pass
 * over one pre-matched base set) rather than issuing several separate
 * queries — matches this codebase's established "one round trip, many
 * results" discipline (OCS's batched eval script, Kamailio's
 * `stats.get_statistics all`).
 *
 * 60s interval — call-volume trend data doesn't need sub-minute freshness,
 * and this keeps aggregation load low. Deliberately a SEPARATE object from
 * CdrSyncMonitor — that class owns the write side (tailing CSVs into
 * Mongo); this one owns the read-and-aggregate-for-Prometheus side, same
 * ingestion/metrics-exposure split already established by OcsReservation
 * Guard (write) vs OcsStatsMonitor (read) in this codebase.
 */

const POLL_INTERVAL_MS = 60_000;
const WINDOWS = ['1h', '24h'] as const;
export type CdrWindow = (typeof WINDOWS)[number];
const WINDOW_MS: Record<CdrWindow, number> = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

export interface CdrCallCount { instance: string; disposition: string; window: CdrWindow; count: number }
export interface CdrTalkTime { instance: string; window: CdrWindow; sumSeconds: number; avgSeconds: number }
export interface CdrTrunkTypeCount { trunkType: string; window: CdrWindow; count: number }

export interface CdrMetricsSnapshot {
  up: boolean;
  sampledAt: number;
  calls: CdrCallCount[];
  talkTime: CdrTalkTime[];
  trunkTypeCalls: CdrTrunkTypeCount[];
}

function emptySnapshot(): CdrMetricsSnapshot {
  return { up: false, sampledAt: Date.now(), calls: [], talkTime: [], trunkTypeCalls: [] };
}

interface GroupCount { _id: { instance?: string; disposition?: string } | string | null; count: number }
interface GroupTalk { _id: string; sum: number | null; avg: number | null }
interface FacetResult {
  calls1h: GroupCount[]; calls24h: GroupCount[];
  talk1h: GroupTalk[]; talk24h: GroupTalk[];
  trunkType1h: GroupCount[]; trunkType24h: GroupCount[];
}

export class CdrMetricsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private latest: CdrMetricsSnapshot = emptySnapshot();

  constructor(private readonly db: Db, private readonly logger: pino.Logger) {}

  start(): void {
    if (this.timer) return;
    this.sample().catch(err => this.logger.debug({ err: String(err) }, 'CDR metrics: initial sample failed'));
    this.timer = setInterval(() => {
      this.sample().catch(err => this.logger.debug({ err: String(err) }, 'CDR metrics: sample failed'));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getLatest(): CdrMetricsSnapshot {
    return this.latest;
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const now = Date.now();
      const since1h = new Date(now - WINDOW_MS['1h']);
      const since24h = new Date(now - WINDOW_MS['24h']);

      const [result] = await this.db.collection<Record<string, unknown>>(CDR_COLLECTION).aggregate<FacetResult>([
        { $match: { sourceSystem: { $in: ['pstn', '2g'] }, startTime: { $gte: since24h } } },
        { $facet: {
          calls1h: [
            { $match: { startTime: { $gte: since1h } } },
            { $group: { _id: { instance: '$sourceSystem', disposition: '$disposition' }, count: { $sum: 1 } } },
          ],
          calls24h: [
            { $group: { _id: { instance: '$sourceSystem', disposition: '$disposition' }, count: { $sum: 1 } } },
          ],
          talk1h: [
            { $match: { startTime: { $gte: since1h }, disposition: 'answered' } },
            { $group: { _id: '$sourceSystem', sum: { $sum: '$durationSeconds' }, avg: { $avg: '$durationSeconds' } } },
          ],
          talk24h: [
            { $match: { disposition: 'answered' } },
            { $group: { _id: '$sourceSystem', sum: { $sum: '$durationSeconds' }, avg: { $avg: '$durationSeconds' } } },
          ],
          trunkType1h: [
            { $match: { sourceSystem: 'pstn', startTime: { $gte: since1h } } },
            { $group: { _id: { $ifNull: ['$trunkType', 'unknown'] }, count: { $sum: 1 } } },
          ],
          trunkType24h: [
            { $match: { sourceSystem: 'pstn' } },
            { $group: { _id: { $ifNull: ['$trunkType', 'unknown'] }, count: { $sum: 1 } } },
          ],
        } },
      ]).toArray();

      const calls: CdrCallCount[] = [];
      const talkTime: CdrTalkTime[] = [];
      const trunkTypeCalls: CdrTrunkTypeCount[] = [];

      if (result) {
        for (const window of WINDOWS) {
          for (const g of result[window === '1h' ? 'calls1h' : 'calls24h']) {
            const id = g._id as { instance?: string; disposition?: string };
            if (id?.instance && id?.disposition) calls.push({ instance: id.instance, disposition: id.disposition, window, count: g.count });
          }
          for (const g of result[window === '1h' ? 'talk1h' : 'talk24h']) {
            talkTime.push({ instance: g._id, window, sumSeconds: g.sum ?? 0, avgSeconds: g.avg ?? 0 });
          }
          for (const g of result[window === '1h' ? 'trunkType1h' : 'trunkType24h']) {
            trunkTypeCalls.push({ trunkType: String(g._id), window, count: g.count });
          }
        }
      }

      this.latest = { up: true, sampledAt: now, calls, talkTime, trunkTypeCalls };
    } catch (err) {
      this.latest = emptySnapshot();
      throw err;
    } finally {
      this.sampling = false;
    }
  }
}
