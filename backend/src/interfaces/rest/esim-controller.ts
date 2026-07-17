import { Router, Request, Response } from 'express';
import pino from 'pino';
import { EsimGeneratorUseCase } from '../../application/use-cases/esim-generator';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

export function createEsimRouter(
  esimGeneratorUseCase: EsimGeneratorUseCase,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router {
  const router = Router();

  // POST /api/esim/generate — Simlessly Single Generate AC.
  // Creates a real, likely billable eSIM activation code on the user's
  // Simlessly account — admin-only, always audit logged.
  router.post('/generate', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { iccid, imsi } = req.body ?? {};

    try {
      const result = await esimGeneratorUseCase.generateAc(req.body ?? {});

      await auditLogger.log({
        action: 'esim_generate', user,
        target: imsi ? String(imsi) : undefined,
        details: `iccid=${iccid} success=${result.success} code=${result.code}`,
        success: result.success,
      });

      res.json({ success: result.success, result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg, iccid, imsi }, 'eSIM generation via Simlessly failed');

      await auditLogger.log({
        action: 'esim_generate', user,
        target: imsi ? String(imsi) : undefined,
        details: `iccid=${iccid} error=${errMsg}`,
        success: false,
      });

      res.status(500).json({ success: false, error: errMsg });
    }
  });

  return router;
}
