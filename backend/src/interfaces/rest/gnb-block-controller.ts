import { Router, Request, Response } from 'express';
import pino from 'pino';
import { GnbBlockService } from '../../application/use-cases/ran/gnb-block-service';
import { GetInterfaceStatus } from '../../application/use-cases/interface-status/get-interface-status';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export const createGnbBlockRouter = (
  gnbBlockService: GnbBlockService,
  getInterfaceStatus: GetInterfaceStatus,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const blocked = await gnbBlockService.listBlocked();
      res.json(blocked);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list blocked gNodeBs');
      res.status(500).json({ error: 'Failed to list blocked gNodeBs' });
    }
  });

  // POST /all — bulk-block every currently connected 5G gNodeB (N2's own live list),
  // mirroring radio-block-controller.ts's 4G kill switch. Declared before /:ip so
  // Express doesn't try to match "all" as an IP.
  router.post('/all', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const status = await getInterfaceStatus.execute();
      const ips = [...new Set(status.n2.connectedGnodebs.map(r => r.ip).filter(ip => IPV4_RE.test(ip)))];
      for (const ip of ips) {
        await gnbBlockService.block(ip, user);
      }
      logger.warn({ ips, user }, 'All connected gNodeBs blocked (RAN kill switch)');
      await auditLogger.log({ action: 'gnb_block', user, details: `ALL ips=${ips.join(',')}`, success: true });
      res.json({ success: true, ips });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to block all gNodeBs');
      await auditLogger.log({ action: 'gnb_block', user, details: `ALL error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block all gNodeBs' });
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
      await gnbBlockService.block(ip, user);
      logger.warn({ ip, user }, 'gNodeB N2/N3 blocked');
      await auditLogger.log({ action: 'gnb_block', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to block gNodeB');
      await auditLogger.log({ action: 'gnb_block', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block gNodeB' });
    }
  });

  router.delete('/:ip', requireAdmin, async (req: Request, res: Response) => {
    const ip = decodeURIComponent(req.params.ip);
    const user = (req as any).user?.username ?? 'unknown';
    try {
      await gnbBlockService.unblock(ip);
      logger.info({ ip, user }, 'gNodeB N2/N3 unblocked');
      await auditLogger.log({ action: 'gnb_unblock', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to unblock gNodeB');
      await auditLogger.log({ action: 'gnb_unblock', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to unblock gNodeB' });
    }
  });

  return router;
};
