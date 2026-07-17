import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { DnsMigrationUseCase } from '../../application/use-cases/dns-migration-usecase';
import { requireAdmin } from './middleware/auth-middleware';

const MIGRATION_BACKUP_ROOT = '/proc/1/root/etc/open5gs/backups/dns-migration';
const MIGRATION_STATE_FILE  = '/proc/1/root/etc/open5gs/backups/dns-migration/state.json';

export function createDnsMigrationRouter(dnsMigrationUseCase: DnsMigrationUseCase): Router {
  const router = Router();

  // GET /api/dns-migration/status — has a migration ever been applied on this host?
  // Drives the frontend's choice between the summary table and the wizard landing.
  router.get('/status', requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, migrated: fs.existsSync(MIGRATION_STATE_FILE) });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/dns-migration/plan — dry-run diff, writes nothing
  router.get('/plan', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const plan = await dnsMigrationUseCase.computeMigrationPlan();
      res.json({ success: true, plan });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/dns-migration/backups — list migration backup ids for the rollback UI
  router.get('/backups', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const exists = fs.existsSync(MIGRATION_BACKUP_ROOT);
      const backups = exists
        ? fs.readdirSync(MIGRATION_BACKUP_ROOT)
            .filter(name => /^\d+$/.test(name))
            .sort((a, b) => parseInt(b) - parseInt(a))
            .map(id => ({ id, createdAt: new Date(parseInt(id)).toISOString() }))
        : [];
      res.json({ success: true, backups });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/dns-migration/backup — create a migration-specific supplementary backup
  // (NF yaml + freeDiameter confs + BIND named.conf.local), returns a backupId to
  // pass to /apply and /rollback.
  router.post('/backup', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const info = await dnsMigrationUseCase.createMigrationBackup();
      res.json({ success: true, ...info });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/dns-migration/apply/:phase — phase is 'a' | 'b' | 'c'
  // Recomputes the plan fresh server-side rather than trusting a client-supplied
  // plan, since this writes live config/DNS/Diameter state.
  router.post('/apply/:phase', requireAdmin, async (req: Request, res: Response) => {
    const phase = (req.params.phase || '').toLowerCase();
    if (!['a', 'b', 'c'].includes(phase)) {
      return res.status(400).json({ success: false, error: "phase must be 'a', 'b', or 'c'" });
    }
    try {
      const plan = await dnsMigrationUseCase.computeMigrationPlan();
      const result = phase === 'a'
        ? await dnsMigrationUseCase.applyPhaseA(plan)
        : phase === 'b'
          ? await dnsMigrationUseCase.applyPhaseB(plan)
          : await dnsMigrationUseCase.applyPhaseC(plan);
      res.json({ success: result.success, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/dns-migration/rollback/:backupId
  router.post('/rollback/:backupId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await dnsMigrationUseCase.rollbackMigration(req.params.backupId);
      res.json({ success: result.success, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
