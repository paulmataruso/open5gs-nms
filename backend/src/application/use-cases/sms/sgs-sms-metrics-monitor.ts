import * as fs from 'fs';
import pino from 'pino';
import { safeNsenter } from '../../../infrastructure/system/safe-nsenter';

// osmo-msc's own inline SMSC database — confirmed live 2026-09-26 at the
// real host-absolute path `/sms.db` (NOT /var/lib/osmocom/sms.db — osmo-msc's
// `database sms.db` directive is relative, and its systemd unit sets no
// WorkingDirectory, so it resolves against the unit's own default cwd). This
// constant is the REAL HOST path, passed as an argument to `sqlite3` running
// INSIDE the host's own mount namespace via safeNsenter/nsenter -m — NOT the
// container-side `/proc/1/root`-prefixed view (that prefix is only needed
// when THIS Node process reads the file directly via its own fs calls,
// which is what the separate existence-gate check below does instead).
const SMS_DB_PATH = '/sms.db';
const HOST_SMS_DB_EXISTS_CHECK = `/proc/1/root${SMS_DB_PATH}`;

const POLL_INTERVAL_MS = 30_000;

export type SgsSmsStatus = 'delivered' | 'pending' | 'expired';
const STATUSES: SgsSmsStatus[] = ['delivered', 'pending', 'expired'];

export interface SgsSmsQueueState {
  up: boolean;
  counts: Record<SgsSmsStatus, number>;
}

// GROUP BY only ever emits a row for a status that actually has >=1 matching
// message — a status with zero current messages (the common case for
// "expired", say) would otherwise just be absent from the result rather than
// a real 0, reintroducing the exact "0 vs no-data" ambiguity this dashboard
// is otherwise careful to avoid (critic review, 2026-09-26). Every caller of
// getLatest() gets all 3 fixed enum values explicitly, defaulted to 0 and
// only overwritten where the query actually returned a row.
const SQL = `SELECT CASE
    WHEN sent IS NOT NULL THEN 'delivered'
    WHEN valid_until < datetime('now') THEN 'expired'
    ELSE 'pending'
  END AS status, COUNT(*) AS count
FROM SMS GROUP BY status;`;

export class SgsSmsMetricsMonitor {
  private timer: NodeJS.Timeout | null = null;
  private latest: SgsSmsQueueState = { up: false, counts: { delivered: 0, pending: 0, expired: 0 } };

  constructor(private readonly logger: pino.Logger) {}

  start(): void {
    if (this.timer) return;
    this.refresh().catch(err => this.logger.debug({ err: String(err) }, 'sgs sms metrics: initial refresh failed'));
    this.timer = setInterval(() => {
      this.refresh().catch(err => this.logger.debug({ err: String(err) }, 'sgs sms metrics: refresh failed'));
    }, POLL_INTERVAL_MS);
  }

  getLatest(): SgsSmsQueueState {
    return this.latest;
  }

  private async refresh(): Promise<void> {
    if (!fs.existsSync(HOST_SMS_DB_EXISTS_CHECK)) {
      this.latest = { up: false, counts: { delivered: 0, pending: 0, expired: 0 } };
      return;
    }
    try {
      // Read-only SELECT against a real WAL-mode DB osmo-msc itself writes to
      // live (confirmed live: PRAGMA busy_timeout=0 on this deployment) — a
      // SQLITE_BUSY collision is real but rare and must not crash this poll;
      // caught below, keeping the last-known-good cache on failure, same
      // shape as every other cache-refresh loop in this codebase
      // (gsm-controller.ts's startBtsCacheRefresh etc.).
      const { stdout } = await safeNsenter('sqlite3', ['-separator', '|', SMS_DB_PATH, SQL], 10000);
      const counts: Record<SgsSmsStatus, number> = { delivered: 0, pending: 0, expired: 0 };
      for (const line of stdout.split('\n').map((l: string) => l.trim()).filter(Boolean)) {
        const [status, countRaw] = line.split('|');
        if ((STATUSES as string[]).includes(status)) {
          counts[status as SgsSmsStatus] = parseInt(countRaw, 10) || 0;
        }
      }
      this.latest = { up: true, counts };
    } catch (err) {
      this.logger.debug({ err: String(err) }, 'sgs sms metrics: query failed — keeping last-known cache');
      this.latest = { ...this.latest, up: false };
    }
  }
}
