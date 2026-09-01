import { Router, Request, Response } from 'express';
import pino from 'pino';
import { RadioBlockService } from '../../application/use-cases/ran/radio-block-service';
import { GetInterfaceStatus } from '../../application/use-cases/interface-status/get-interface-status';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export const createRadioBlockRouter = (
  radioBlockService: RadioBlockService,
  getInterfaceStatus: GetInterfaceStatus,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const blocked = await radioBlockService.listBlocked();
      res.json(blocked);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list blocked radios');
      res.status(500).json({ error: 'Failed to list blocked radios' });
    }
  });

  // POST /all — bulk-block every currently connected 4G eNodeB (S1-MME's own live list,
  // the authoritative "what's actually connected right now" source), for the RAN page's
  // header-level "Block RAN" kill switch. Declared before /:ip so Express doesn't try to
  // match "all" as an IP.
  router.post('/all', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const status = await getInterfaceStatus.execute();
      const ips = [...new Set(status.s1mme.connectedEnodebs.map(r => r.ip).filter(ip => IPV4_RE.test(ip)))];
      for (const ip of ips) {
        await radioBlockService.block(ip, user);
      }
      logger.warn({ ips, user }, 'All connected radios blocked (RAN kill switch)');
      await auditLogger.log({ action: 'radio_block', user, details: `ALL ips=${ips.join(',')}`, success: true });
      res.json({ success: true, ips });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to block all radios');
      await auditLogger.log({ action: 'radio_block', user, details: `ALL error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block all radios' });
    }
  });

  router.post('/:ip', requireAdmin, async (req: Request, res: Response) => {
    const ip = decodeURIComponent(req.params.ip);
    const user = (req as any).user?.username ?? 'unknown';
    if (!IPV4_RE.test(ip)) {
      res.status(400).json({ error: 'Invalid IPv4 address' });
      return;
    }
    try {
      await radioBlockService.block(ip, user);
      logger.warn({ ip, user }, 'Radio S1-MME/S1-U blocked');
      await auditLogger.log({ action: 'radio_block', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to block radio');
      await auditLogger.log({ action: 'radio_block', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block radio' });
    }
  });

  router.delete('/:ip', requireAdmin, async (req: Request, res: Response) => {
    const ip = decodeURIComponent(req.params.ip);
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await radioBlockService.unblock(ip);
      logger.info({ ip, user }, 'Radio S1-MME/S1-U unblocked');
      await auditLogger.log({ action: 'radio_unblock', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to unblock radio');
      await auditLogger.log({ action: 'radio_unblock', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to unblock radio' });
    }
  });

  return router;
};
