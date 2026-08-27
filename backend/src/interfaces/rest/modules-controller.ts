import { Router, Request, Response } from 'express';
import pino from 'pino';
import { requireAdmin } from './middleware/auth-middleware';
import { ModuleFixAllUseCase } from '../../application/use-cases/module-fixall-usecase';

// ── Centralized stale-module aggregation + Fix All ──────────────────────────
//
// Backs the global StaleModulesModal popup — see module-fixall-usecase.ts for
// the full rationale. Three fast, small endpoints (no streaming): the
// aggregation call does a handful of cheap file-existence/version-compare
// checks per module (a couple of which do one lightweight nsenter subprocess
// call each), and the fix-all kickoff returns immediately after starting a
// detached in-process run — none of these need the long nginx timeout tier
// every per-module streaming /install endpoint uses (nginx.conf's `^/api/
// (ims|sms|...)/(install|uninstall|remove)` regex), since the actual
// Install/Configure work happens as in-process function calls, not over HTTP.
export function createModulesRouter(useCase: ModuleFixAllUseCase, logger: pino.Logger): Router {
  const router = Router();

  router.get('/stale-status', async (_req: Request, res: Response) => {
    try {
      const modules = await useCase.getStaleStatus();
      res.json({ success: true, modules });
    } catch (err) {
      logger.error({ err: String(err) }, 'modules stale-status error');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post('/fix-all', requireAdmin, (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const result = useCase.startFixAll(user);
    if (!result.started) {
      return res.status(409).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  });

  router.get('/fix-all/status', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, run: useCase.getRunState() });
  });

  return router;
}
