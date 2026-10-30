import { Router, Request, Response } from 'express';
import pino from 'pino';
import { UeDeregisterUseCase } from '../../application/use-cases/ran/ue-deregister';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const IMSI_RE = /^\d{6,15}$/;

/**
 * POST /api/ue/:imsi/deregister — bounce a UE so it re-attaches by itself.
 *
 * Mounted under /api/ue rather than /api/ue-block deliberately: this action
 * installs no block and the two are meant to stay separable, so filing a
 * non-blocking action inside a blocking namespace would mislead the next
 * reader of either the route table or an audit log.
 *
 * nginx needs no new location block — /api/ is already covered, and this is a
 * single ~15s request, nowhere near the streaming-install timeouts.
 */
export const createUeDeregisterRouter = (
  useCase: UeDeregisterUseCase,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.post('/:imsi/deregister', requireAdmin, async (req: Request, res: Response) => {
    const imsi = decodeURIComponent(req.params.imsi);
    const user = (req as any).user?.username ?? 'unknown';
    if (!IMSI_RE.test(imsi)) {
      res.status(400).json({ error: 'Invalid IMSI' });
      return;
    }

    try {
      const result = await useCase.deregister(imsi);
      logger.warn({ imsi, user, result }, 'UE deregister (bounce) requested');
      // The generation and the re-attach flag are both recorded on purpose:
      // two different NAS detach behaviours now flow through one tool, so an
      // audit line that omits which bit was set cannot later answer "why did
      // that UE not come back".
      await auditLogger.log({
        action: 'ue_deregister',
        user,
        details: `imsi=${imsi} generation=${result.generation} status=${result.status} reattach=${result.reattachRequested}`,
        // An expected, correctly-reported outcome ("that UE is not attached")
        // is not a failed action. Only a genuine malfunction is.
        success: result.status !== 'error' && result.status !== 'lookup-failed',
      });
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err: String(err), imsi }, 'Failed to deregister UE');
      await auditLogger.log({
        action: 'ue_deregister', user,
        details: `imsi=${imsi} error=${String(err)}`, success: false,
      });
      res.status(500).json({ error: 'Failed to deregister UE' });
    }
  });

  return router;
};
