import { Router, Request, Response } from 'express';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { AuditAction } from '../../domain/entities/audit-log';
import pino from 'pino';

export function createAuditRouter(auditLogger: IAuditLogger, logger: pino.Logger): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const limit = parseInt(req.query.limit as string) || 100;
      const action = req.query.action as AuditAction | undefined;

      const entries = action
        ? await auditLogger.getByAction(action, skip, limit)
        : await auditLogger.getAll(skip, limit);
      const total = await auditLogger.count();

      res.json({ entries, total });
    } catch (err) {
      logger.error({ err }, 'Failed to get audit logs');
      res.status(500).json({ error: 'Failed to get audit logs' });
    }
  });

  return router;
}
