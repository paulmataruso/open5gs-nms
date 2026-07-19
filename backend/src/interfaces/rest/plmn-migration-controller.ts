import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { PlmnMigrationUseCase } from '../../application/use-cases/plmn-migration-usecase';
import { requireAdmin } from './middleware/auth-middleware';

// Backups live under the SAME directory DnsMigrationUseCase already uses —
// PlmnMigrationUseCase.createMigrationBackup() delegates to
// dnsMigrationUseCase.createMigrationBackup() for the 17-NF yaml/freeDiameter/
// BIND snapshot, only adding IMS/VoWiFi's own state files alongside it.
const MIGRATION_BACKUP_ROOT = '/proc/1/root/etc/open5gs/backups/dns-migration';

const PHASES = ['a', 'b', 'c', 'd', 'e'] as const;
type Phase = typeof PHASES[number];

export function createPlmnMigrationRouter(plmnMigrationUseCase: PlmnMigrationUseCase): Router {
  const router = Router();

  const parsePlmn = (req: Request): { mcc: string; mnc: string } | null => {
    const mcc = (req.body?.mcc ?? req.query?.mcc) as string | undefined;
    const mnc = (req.body?.mnc ?? req.query?.mnc) as string | undefined;
    if (!mcc || !mnc) return null;
    return { mcc: String(mcc), mnc: String(mnc) };
  };

  // GET /api/plmn-migration/status — has a migration ever been applied on this host?
  router.get('/status', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const exists = fs.existsSync(MIGRATION_BACKUP_ROOT) &&
        fs.readdirSync(MIGRATION_BACKUP_ROOT).some(name => /^\d+$/.test(name));
      res.json({ success: true, migrated: exists });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/plmn-migration/plan?mcc=999&mnc=070 — dry-run diff, writes nothing
  router.get('/plan', requireAdmin, async (req: Request, res: Response) => {
    const target = parsePlmn(req);
    if (!target) return res.status(400).json({ success: false, error: 'mcc and mnc query params are required' });
    try {
      const plan = await plmnMigrationUseCase.computeMigrationPlan(target.mcc, target.mnc);
      res.json({ success: true, plan });
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/plmn-migration/backups — list backup ids for the rollback UI
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

  // POST /api/plmn-migration/backup — body: { mcc, mnc } — recomputes the plan
  // server-side, then creates a supplementary backup + persists old/new PLMN
  // state for the later phases (esp. Phase D) to recover.
  router.post('/backup', requireAdmin, async (req: Request, res: Response) => {
    const target = parsePlmn(req);
    if (!target) return res.status(400).json({ success: false, error: 'mcc and mnc are required' });
    try {
      const plan = await plmnMigrationUseCase.computeMigrationPlan(target.mcc, target.mnc);
      const info = await plmnMigrationUseCase.createMigrationBackup(plan);
      res.json({ success: true, plan, ...info });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/plmn-migration/apply/:phase — phase is 'a' | 'b' | 'c' | 'd' | 'e'
  // Recomputes the plan fresh server-side each time rather than trusting a
  // client-supplied plan, same convention as /api/dns-migration/apply/:phase —
  // this writes live config/DNS/Diameter/application state.
  router.post('/apply/:phase', requireAdmin, async (req: Request, res: Response) => {
    const phase = (req.params.phase || '').toLowerCase() as Phase;
    if (!PHASES.includes(phase)) {
      return res.status(400).json({ success: false, error: "phase must be 'a', 'b', 'c', 'd', or 'e'" });
    }
    const target = parsePlmn(req);
    if (!target) return res.status(400).json({ success: false, error: 'mcc and mnc are required' });
    try {
      const plan = await plmnMigrationUseCase.computeMigrationPlan(target.mcc, target.mnc);
      const result = phase === 'a' ? await plmnMigrationUseCase.applyPhaseA(plan)
        : phase === 'b' ? await plmnMigrationUseCase.applyPhaseB(plan)
        : phase === 'c' ? await plmnMigrationUseCase.applyPhaseC(plan)
        : phase === 'd' ? await plmnMigrationUseCase.applyPhaseD(plan)
        : await plmnMigrationUseCase.applyPhaseE(plan);
      res.json({ success: result.success, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/plmn-migration/rollback/:backupId
  router.post('/rollback/:backupId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await plmnMigrationUseCase.rollbackMigration(req.params.backupId);
      res.json({ success: result.success, result });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
