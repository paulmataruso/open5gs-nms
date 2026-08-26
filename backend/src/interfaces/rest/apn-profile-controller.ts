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

  // ── IPv6 pool (#30 follow-up) ────────────────────────────────────────────
  // Registered BEFORE the /:id routes below — Express matches in
  // registration order, and PUT /:id would otherwise swallow PUT
  // /ipv6-settings as an update for a profile literally named "ipv6-settings".
  // GET is open like every other read-only config endpoint above; the
  // setter mutates NMS-only Mongo state (not smf.yaml/upf.yaml directly —
  // that only happens through create()/update() below), but still gets
  // requireAdmin + an audit entry since it changes what future profiles
  // auto-allocate into.

  router.get('/ipv6-settings', async (_req: Request, res: Response) => {
    try {
      const parentPrefix = await useCase.getIPv6ParentPrefix();
      res.json({ success: true, parentPrefix });
    } catch (err) {
      logger.error({ err: String(err) }, 'apn-profiles: get ipv6 settings failed');
      res.status(500).json({ success: false, error: 'Failed to load IPv6 pool settings' });
    }
  });

  router.put('/ipv6-settings', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { parentPrefix } = req.body as { parentPrefix?: string | null };
      await useCase.setIPv6ParentPrefix(parentPrefix ?? null);
      await auditLogger.log({ action: 'apn_profile_ipv6_settings_update', user, details: `parentPrefix=${parentPrefix || '(cleared)'}`, success: true });
      res.json({ success: true, parentPrefix: parentPrefix || null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'apn_profile_ipv6_settings_update', user, details: message, success: false });
      res.status(400).json({ success: false, error: message });
    }
  });

  // Preview-only — does NOT reserve/persist anything (see
  // allocateNextIPv6Subnet()'s own comment for why: it's derived live from
  // existing profiles every call, so there's nothing to "release" if the
  // operator previews but doesn't actually save a profile).
  router.get('/ipv6-preview', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const next = await useCase.allocateNextIPv6Subnet();
      res.json({ success: true, next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
