import { Router } from 'express';
import pino from 'pino';
import { GetInterfaceStatus } from '../../application/use-cases/interface-status/get-interface-status';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { ActiveSessionsUseCase } from '../../application/use-cases/active-sessions';

export const createInterfaceRouter = (
  hostExecutor: IHostExecutor,
  logger: pino.Logger,
  activeSessionsUseCase: ActiveSessionsUseCase,
): Router => {
  const router = Router();
  const getInterfaceStatus = new GetInterfaceStatus(hostExecutor, logger, activeSessionsUseCase);

  router.get('/', async (_req, res) => {
    try {
      const status = await getInterfaceStatus.execute();
      res.json(status);
    } catch (error) {
      logger.error({ error }, 'Failed to get interface status');
      res.status(500).json({ error: 'Failed to get interface status' });
    }
  });

  return router;
};
