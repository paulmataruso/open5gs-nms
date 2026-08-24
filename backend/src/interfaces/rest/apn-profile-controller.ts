import { Router, Request, Response } from 'express';
import pino from 'pino';
import { ApnProfileUseCase, ApnProfileInput } from '../../application/use-cases/apn-profile-usecase';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

// Unlike rf-planning-projects-controller.ts (pure NMS-only data, no requireAdmin/audit
// log), saving/deleting an APN profile writes to live smf.yaml/upf.yaml (create/update)
// — same blast radius as any other core-config-writing controller in this app
// (secgw-controller.ts, syslog-controller.ts, ...), so mutating routes get requireAdmin
// + an audit trail the same way those do. GET routes stay open, matching every other
// read-only config endpoint.
export function createApnProfileRouter(useCase: ApnProfileUseCase, logger: pino.Logger, auditLogger: IAuditLogger): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const profiles = await useCase.list();
      res.json({ success: true, profiles });
    } catch (err) {
      logger.error({ err: String(err) }, 'apn-profiles: list failed');
      res.status(500).json({ success: false, error: 'Failed to list APN profiles' });
    }
  });

  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const input = req.body as ApnProfileInput;
      const profile = await useCase.create(input);
      await auditLogger.log({ action: 'apn_profile_create', user, details: `dnn=${profile.dnn} dev=${profile.dev}`, success: true });
      res.status(201).json({ success: true, profile });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'apn_profile_create', user, details: message, success: false });
      res.status(400).json({ success: false, error: message });
    }
  });

  router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const input = req.body as ApnProfileInput;
      const profile = await useCase.update(req.params.id, input);
      await auditLogger.log({ action: 'apn_profile_update', user, details: `id=${req.params.id} dnn=${profile.dnn}`, success: true });
      res.json({ success: true, profile });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'apn_profile_update', user, details: message, success: false });
      res.status(400).json({ success: false, error: message });
    }
  });

  router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await useCase.delete(req.params.id);
      await auditLogger.log({ action: 'apn_profile_delete', user, details: `id=${req.params.id}`, success: true });
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'apn_profile_delete', user, details: message, success: false });
      res.status(500).json({ success: false, error: message });
    }
  });

  // Promotes a derived (config-only) DNN into a real, persisted profile —
  // see ApnProfileUseCase.createFromDerived()'s comment for why this is
  // Mongo-only (no smf.yaml/upf.yaml write needed).
  router.post('/:dnn/promote', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const profile = await useCase.createFromDerived(req.params.dnn);
      await auditLogger.log({ action: 'apn_profile_promote', user, details: `dnn=${profile.dnn}`, success: true });
      res.status(201).json({ success: true, profile });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'apn_profile_promote', user, details: message, success: false });
      res.status(400).json({ success: false, error: message });
    }
  });

  return router;
}
