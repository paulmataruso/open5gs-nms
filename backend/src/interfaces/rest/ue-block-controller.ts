import { Router, Request, Response } from 'express';
import pino from 'pino';
import { UeBlockService } from '../../application/use-cases/ran/ue-block-service';
import { isUeDetachToolBuilt, isOpen5gsSrcTreeAvailable, installUeDetachTool, runUeDetach } from '../../application/use-cases/ran/ue-detach-runner';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const IMSI_RE = /^\d{6,15}$/;
const DETACH_TIMEOUT_MS = 15_000;

export const createUeBlockRouter = (
  ueBlockService: UeBlockService,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      success: true,
      built: isUeDetachToolBuilt(),
      open5gsSrcAvailable: isOpen5gsSrcTreeAvailable(),
    });
  });

  router.post('/install', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const write = (s: string) => res.write(s);
    const result = await installUeDetachTool(write);
    await auditLogger.log({ action: 'ue_detach_install', user, details: `success=${result.success}`, success: result.success });
    res.end();
  });

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const blocked = await ueBlockService.listBlocked();
      res.json(blocked);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list blocked UEs');
      res.status(500).json({ error: 'Failed to list blocked UEs' });
    }
  });

  // Block = immediate real detach (Cancel-Location-Request, best-effort — the UE
  // might not currently be attached, or the detach tool might not be installed yet,
  // neither of which should stop the persistent block from being applied) + a
  // persistent per-UE nftables blackhole that survives any future re-attach.
  router.post('/:imsi', requireAdmin, async (req: Request, res: Response) => {
    const imsi = decodeURIComponent(req.params.imsi);
    const user = (req as any).user?.username ?? 'unknown';
    if (!IMSI_RE.test(imsi)) {
      res.status(400).json({ error: 'Invalid IMSI' });
      return;
    }

    let detach: { attempted: boolean; status?: string; message?: string } = { attempted: false };
    if (isUeDetachToolBuilt()) {
      try {
        const outcome = await runUeDetach(imsi, DETACH_TIMEOUT_MS);
        detach = { attempted: true, status: outcome.status, message: outcome.message };
      } catch (err) {
        detach = { attempted: true, status: 'error', message: String(err) };
        logger.warn({ err: String(err), imsi }, 'ue-block: detach attempt failed, proceeding with block anyway');
      }
    }

    try {
      await ueBlockService.block(imsi, user);
      logger.warn({ imsi, user, detach }, 'UE blocked (detach + persistent nftables block)');
      await auditLogger.log({ action: 'ue_block', user, details: `imsi=${imsi} detach=${JSON.stringify(detach)}`, success: true });
      res.json({ success: true, imsi, detach });
    } catch (err) {
      logger.error({ err: String(err), imsi }, 'Failed to block UE');
      await auditLogger.log({ action: 'ue_block', user, details: `imsi=${imsi} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block UE', detach });
    }
  });

  router.delete('/:imsi', requireAdmin, async (req: Request, res: Response) => {
    const imsi = decodeURIComponent(req.params.imsi);
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await ueBlockService.unblock(imsi);
      logger.info({ imsi, user }, 'UE unblocked');
      await auditLogger.log({ action: 'ue_unblock', user, details: `imsi=${imsi}`, success: true });
      res.json({ success: true, imsi });
    } catch (err) {
      logger.error({ err: String(err), imsi }, 'Failed to unblock UE');
      await auditLogger.log({ action: 'ue_unblock', user, details: `imsi=${imsi} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to unblock UE' });
    }
  });

  return router;
};
