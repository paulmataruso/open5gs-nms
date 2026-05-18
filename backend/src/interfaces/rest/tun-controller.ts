import { Router, Request, Response } from 'express';
import pino from 'pino';
import { TunManagementUseCase } from '../../application/use-cases/tun-management';
import { requireAdmin } from './middleware/auth-middleware';

export const createTunRouter = (
  tunUseCase: TunManagementUseCase,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // ── GET / — list all ogstun* interfaces ────────────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const [interfaces, networkdActive, nextName] = await Promise.all([
        tunUseCase.list(),
        tunUseCase.checkNetworkdActive(),
        tunUseCase.suggestNextName(),
      ]);
      res.json({ interfaces, networkdActive, nextName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list TUN interfaces');
      res.status(500).json({ error: msg });
    }
  });

  // ── POST / — create a new managed TUN interface ─────────────────────────────
  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name, ip, prefix } = req.body as { name: string; ip: string; prefix: number };
      if (!name || !ip || !prefix) {
        res.status(400).json({ error: 'name, ip, and prefix are required' });
        return;
      }
      await tunUseCase.create({ name, ip, prefix });
      res.json({ success: true, message: `Interface ${name} created` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to create TUN interface');
      res.status(400).json({ error: msg });
    }
  });

  // ── PUT /:name — edit IP on a managed interface ────────────────────────────
  router.put('/:name', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { ip, prefix } = req.body as { ip: string; prefix: number };
      if (!ip || !prefix) {
        res.status(400).json({ error: 'ip and prefix are required' });
        return;
      }
      await tunUseCase.edit(name, { ip, prefix });
      res.json({ success: true, message: `Interface ${name} updated` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to edit TUN interface');
      res.status(400).json({ error: msg });
    }
  });

  // ── DELETE /:name — delete a managed interface ─────────────────────────────
  router.delete('/:name', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      await tunUseCase.delete(name);
      res.json({ success: true, message: `Interface ${name} deleted` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to delete TUN interface');
      res.status(400).json({ error: msg });
    }
  });

  // ── POST /:name/up — bring interface up ─────────────────────────────────────
  router.post('/:name/up', requireAdmin, async (req: Request, res: Response) => {
    try {
      await tunUseCase.setUp(req.params.name);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // ── POST /:name/down — bring interface down ──────────────────────────────────
  router.post('/:name/down', requireAdmin, async (req: Request, res: Response) => {
    try {
      await tunUseCase.setDown(req.params.name);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  return router;
};
