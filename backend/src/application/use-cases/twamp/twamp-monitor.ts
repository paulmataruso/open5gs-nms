import { Db, ObjectId } from 'mongodb';
import pino from 'pino';
import { IHostExecutor } from '../../../domain/interfaces/host-executor';
import { isTwampInstalled, runTwampTest, TwampMode, TwampProtocol, TwampTestResult } from './twamp-runner';
import { recordTwampHistorySample } from './twamp-history';

export interface TwampTargetDoc {
  _id: ObjectId;
  name: string;
  host: string;
  port: number;
  protocol: TwampProtocol;
  mode: TwampMode;
  sharedSecret?: string;
  keyId?: string;
  packetCount: number;
  bindIp?: string;
  pollIntervalSeconds: number;
  enabled: boolean;
  createdAt: number;
}

export interface TwampCachedResult extends TwampTestResult {
  targetId: string;
  name: string;
  host: string;
  timestamp: number;
}

const TICK_MS = 10_000;
export const TWAMP_TARGETS_COLLECTION = 'nms_twamp_targets';

// Background poller — mirrors GtpBandwidthMonitor's shape
// (interface-status/gtp-bandwidth.ts): a setInterval loop that keeps the
// LATEST result per target cached in memory, plus a cheap getter. This is
// deliberately decoupled from Prometheus's own scrape interval (unlike
// prometheus-metrics.ts's collect()-reads-a-live-counter pattern) — a TWAMP
// test is a real ~10s network operation per target, not a cheap counter
// read, so running one on every scrape would block /metrics and hammer the
// reflector. Each target polls on its own pollIntervalSeconds cadence,
// independent of how often Prometheus actually scrapes this backend.
export class TwampMonitor {
  private readonly timer: NodeJS.Timeout;
  private readonly latest = new Map<string, TwampCachedResult>();
  private readonly lastRunAt = new Map<string, number>();
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err: String(err) }, 'twamp monitor tick failed'));
    }, TICK_MS);
  }

  private async tick(): Promise<void> {
    // A slow poll cycle (many targets, one stuck test) re-entering itself
    // before it finished would double-fire tests against the same targets —
    // skip this tick rather than overlap.
    if (this.ticking || !isTwampInstalled()) return;
    this.ticking = true;
    try {
      const targets = await this.db.collection<TwampTargetDoc>(TWAMP_TARGETS_COLLECTION)
        .find({ enabled: true }).toArray();
      const now = Date.now();
      for (const t of targets) {
        const id = String(t._id);
        const last = this.lastRunAt.get(id) ?? 0;
        const intervalMs = (t.pollIntervalSeconds > 0 ? t.pollIntervalSeconds : 60) * 1000;
        if (now - last < intervalMs) continue;
        this.lastRunAt.set(id, now);

        // Fire-and-forget per target — one slow/unreachable reflector must
        // not delay polling the others, and must not block this tick.
        // Normalize a thrown/rejected test into the same TwampTestResult
        // shape first, so the in-memory cache and the persisted history
        // sample are always built from the exact same result — a failure to
        // WRITE the history doc must never get conflated with the TEST
        // itself having failed.
        runTwampTest(this.hostExecutor, t)
          .then(
            (result): TwampTestResult => result,
            (err): TwampTestResult => ({ success: false, error: String(err) }),
          )
          .then(result => {
            this.latest.set(id, { targetId: id, name: t.name, host: t.host, timestamp: Date.now(), ...result });
            return recordTwampHistorySample(this.db, t, result)
              .catch(err => this.logger.error({ err: String(err) }, 'failed to record twamp history sample'));
          });
      }
    } finally {
      this.ticking = false;
    }
  }

  async getLatestResults(): Promise<TwampCachedResult[]> {
    return Array.from(this.latest.values());
  }
}
