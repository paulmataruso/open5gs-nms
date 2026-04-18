import { Router, Request, Response } from 'express';
import { SubscriberManagementUseCase } from '../../application/use-cases/subscriber-management';
import { AutoAssignIPsUseCase } from '../../application/use-cases/auto-assign-ips-usecase';
import pino from 'pino';

export function createSubscriberRouter(
  subscriberUC: SubscriberManagementUseCase,
  autoAssignIPsUC: AutoAssignIPsUseCase,
  logger: pino.Logger
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string | undefined;
      const result = search ? await subscriberUC.search(search, skip, limit) : await subscriberUC.list(skip, limit);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to list subscribers');
      res.status(500).json({ error: 'Failed to list subscribers' });
    }
  });

  // Get IP assignments for all subscribers (MUST be before /:imsi route)
  router.get('/ip-assignments', async (req: Request, res: Response) => {
    try {
      const assignments = await autoAssignIPsUC.getIPAssignments();
      res.json({
        success: true,
        data: assignments,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get IP assignments');
      res.status(500).json({ success: false, error: 'Failed to get IP assignments' });
    }
  });

  router.get('/:imsi', async (req: Request, res: Response) => {
    try {
      const subscriber = await subscriberUC.getByImsi(req.params.imsi);
      if (!subscriber) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(subscriber);
    } catch (err) {
      logger.error({ err }, 'Failed to get subscriber');
      res.status(500).json({ error: 'Failed to get subscriber' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      await subscriberUC.create(req.body);
      res.status(201).json({ message: 'Created' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.put('/:imsi', async (req: Request, res: Response) => {
    try {
      await subscriberUC.update(req.params.imsi, req.body);
      res.json({ message: 'Updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/:imsi', async (req: Request, res: Response) => {
    try {
      await subscriberUC.delete(req.params.imsi);
      res.json({ message: 'Deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  // Auto-assign IPs to all subscribers
  router.post('/auto-assign-ips', async (req: Request, res: Response) => {
    try {
      logger.info('Auto-assigning IPs to all subscribers');
      const result = await autoAssignIPsUC.execute();
      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to auto-assign IPs');
      const msg = err instanceof Error ? err.message : 'Failed to auto-assign IPs';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
