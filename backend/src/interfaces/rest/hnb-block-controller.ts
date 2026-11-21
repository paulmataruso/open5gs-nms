import { Router, Request, Response } from 'express';
import pino from 'pino';
import { HnbBlockService } from '../../application/use-cases/ran/hnb-block-service';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { hnbgwVtyCommand, listRegisteredHnbIps } from './hnbgw-controller';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export const createHnbBlockRouter = (
  hnbBlockService: HnbBlockService,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router => {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const blocked = await hnbBlockService.listBlocked();
      res.json(blocked);
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to list blocked HNBs');
      res.status(500).json({ error: 'Failed to list blocked HNBs' });
    }
  });

  // POST /all — bulk-block every currently registered HNB (osmo-hnbgw's own
  // live "show hnb all" list), mirroring radio-block-controller.ts's 4G and
  // gnb-block-controller.ts's 5G kill switches. Declared before /:ip so
  // Express doesn't try to match "all" as an IP. Unlike those two, there's no
  // GetInterfaceStatus source for 3G — HNBGW's own VTY is the only live
  // "who's connected right now" source.
  router.post('/all', requireAdmin, async (req: Request, res: Response) => {
    const user = req.user?.username ?? 'unknown';
    try {
      const hnbListRaw = await hnbgwVtyCommand('show hnb all').catch(() => '');
      const ips = [...new Set(listRegisteredHnbIps(hnbListRaw).filter(ip => IPV4_RE.test(ip)))];
      for (const ip of ips) {
        await hnbBlockService.block(ip, user);
      }
      logger.warn({ ips, user }, 'All registered HNBs blocked (RAN kill switch)');
      await auditLogger.log({ action: 'hnb_block', user, details: `ALL ips=${ips.join(',')}`, success: true });
      res.json({ success: true, ips });
    } catch (err) {
      logger.error({ err: String(err) }, 'Failed to block all HNBs');
      await auditLogger.log({ action: 'hnb_block', user, details: `ALL error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block all HNBs' });
    }
  });

  router.post('/:ip', requireAdmin, async (req: Request, res: Response) => {
    const ip = decodeURIComponent(req.params.ip);
    const user = req.user?.username ?? 'unknown';
    if (!IPV4_RE.test(ip)) {
      res.status(400).json({ error: 'Invalid IPv4 address' });
      return;
    }
    try {
      await hnbBlockService.block(ip, user);
      logger.warn({ ip, user }, 'HNB Iuh blocked');
      await auditLogger.log({ action: 'hnb_block', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to block HNB');
      await auditLogger.log({ action: 'hnb_block', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to block HNB' });
    }
  });

  router.delete('/:ip', requireAdmin, async (req: Request, res: Response) => {
    const ip = decodeURIComponent(req.params.ip);
    const user = req.user?.username ?? 'unknown';
    try {
      await hnbBlockService.unblock(ip);
      logger.info({ ip, user }, 'HNB Iuh unblocked');
      await auditLogger.log({ action: 'hnb_unblock', user, details: `ip=${ip}`, success: true });
      res.json({ success: true, ip });
    } catch (err) {
      logger.error({ err: String(err), ip }, 'Failed to unblock HNB');
      await auditLogger.log({ action: 'hnb_unblock', user, details: `ip=${ip} error=${String(err)}`, success: false });
      res.status(500).json({ error: 'Failed to unblock HNB' });
    }
  });

  return router;
};
