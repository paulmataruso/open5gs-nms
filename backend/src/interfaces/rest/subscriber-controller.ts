import { Router, Request, Response } from 'express';
import { SubscriberManagementUseCase } from '../../application/use-cases/subscriber-management';
import pino from 'pino';

export function createSubscriberRouter(subscriberUC: SubscriberManagementUseCase, logger: pino.Logger): Router {
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

  return router;
}
