import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { Db } from 'mongodb';
import pino from 'pino';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { CdrSyncMonitor } from '../../application/use-cases/cdr/cdr-sync-monitor';
import {
  CdrDisposition, CdrSourceSystem, DEFAULT_CDR_RETENTION_DAYS, MAX_CDR_RETENTION_DAYS,
  MIN_CDR_RETENTION_DAYS, ensureCdrIndexes, queryCdrs,
} from '../../application/use-cases/cdr/cdr-store';
import { setCdrAccountingEnabled } from './ims-controller';

// ── Call Detail Records — unified read API over nms_cdr ──────────────────
//
// Phase 1: read-only list/filter over Asterisk-sourced (PSTN today,
// Asterisk-2G once Phase 2 lands) call records synced by CdrSyncMonitor.
// Phase 3: POST /kamailio-acc toggles Kamailio's own `acc` module on the
// S-CSCF (direct 4G/5G IMS-to-IMS calls, the one source with no B2BUA CDR of
// its own) — a static import of setCdrAccountingEnabled from ims-controller.ts
// is safe here (one-directional: ims-controller.ts has no reason to ever
// import back from this file), matching CLAUDE.md's cross-module-import
// pattern for a genuinely one-way relationship.

const HOST_CDR_STATE = '/proc/1/root/etc/open5gs/.cdr-settings.json';

interface CdrSettings {
  retentionDays: number;
}

function readCdrSettings(): CdrSettings {
  try {
    if (fs.existsSync(HOST_CDR_STATE)) {
      const parsed = JSON.parse(fs.readFileSync(HOST_CDR_STATE, 'utf-8'));
      const retentionDays = Number(parsed.retentionDays);
      if (Number.isFinite(retentionDays) && retentionDays >= MIN_CDR_RETENTION_DAYS && retentionDays <= MAX_CDR_RETENTION_DAYS) {
        return { retentionDays };
      }
    }
  } catch { /* corrupt/missing — fall through to default */ }
  return { retentionDays: DEFAULT_CDR_RETENTION_DAYS };
}

function writeCdrSettings(settings: CdrSettings): void {
  fs.mkdirSync('/proc/1/root/etc/open5gs', { recursive: true });
  fs.writeFileSync(HOST_CDR_STATE, JSON.stringify(settings, null, 2), 'utf-8');
}

export function createCdrRouter(
  db: Db,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
  syncMonitor: CdrSyncMonitor,
): Router {
  const router = Router();

  // GET / — paginated, filterable list. Query params: from, to (ISO
  // datetimes), sourceSystem, imsi, disposition, page, pageSize.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const q = req.query;
      const result = await queryCdrs(db, {
        from: q.from ? new Date(q.from as string) : undefined,
        to: q.to ? new Date(q.to as string) : undefined,
        sourceSystem: q.sourceSystem as CdrSourceSystem | undefined,
        imsi: q.imsi as string | undefined,
        disposition: q.disposition as CdrDisposition | undefined,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err: String(err) }, 'cdr list error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.get('/settings', requireAdmin, async (_req: Request, res: Response) => {
    res.json({ success: true, ...readCdrSettings() });
  });

  router.put('/settings', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    const { retentionDays } = req.body as { retentionDays?: number };
    if (!Number.isFinite(retentionDays) || retentionDays! < MIN_CDR_RETENTION_DAYS || retentionDays! > MAX_CDR_RETENTION_DAYS) {
      return res.status(400).json({ success: false, error: `retentionDays must be between ${MIN_CDR_RETENTION_DAYS} and ${MAX_CDR_RETENTION_DAYS}` });
    }
    try {
      await ensureCdrIndexes(db, retentionDays!);
      writeCdrSettings({ retentionDays: retentionDays! });
      await auditLogger.log({ action: 'cdr_sync_settings_update', user, details: `retentionDays=${retentionDays}`, success: true });
      res.json({ success: true, retentionDays });
    } catch (err) {
      await auditLogger.log({ action: 'cdr_sync_settings_update', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'cdr settings update error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // Manual trigger — same "don't make the operator wait for the next poll
  // interval" convenience this project already gives other background
  // pollers (e.g. OCS's own manual /sync-subscribers).
  router.post('/sync-now', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    try {
      await syncMonitor.syncNow();
      await auditLogger.log({ action: 'cdr_sync_force_run', user, details: 'manual sync', success: true });
      res.json({ success: true });
    } catch (err) {
      await auditLogger.log({ action: 'cdr_sync_force_run', user, details: String(err), success: false });
      logger.error({ err: String(err) }, 'cdr manual sync error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // POST /kamailio-acc — body: { enabled: boolean }. Toggles CDR capture for
  // direct IMS-to-IMS calls (see setCdrAccountingEnabled()'s own comment).
  // No availability guard needed (unlike voice-charging's OCS dependency) —
  // this only touches the already-running scscf MySQL database.
  router.post('/kamailio-acc', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }
    try {
      await setCdrAccountingEnabled(enabled);
      await auditLogger.log({
        action: enabled ? 'cdr_kamailio_acc_enable' : 'cdr_kamailio_acc_disable',
        user, details: 'kamailio-scscf acc module', success: true,
      });
      res.json({ success: true, enabled });
    } catch (err) {
      await auditLogger.log({
        action: enabled ? 'cdr_kamailio_acc_enable' : 'cdr_kamailio_acc_disable',
        user, details: String(err), success: false,
      });
      logger.error({ err: String(err) }, 'cdr kamailio-acc toggle error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}

export { readCdrSettings };
