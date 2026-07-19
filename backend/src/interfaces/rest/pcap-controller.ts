import { Router, Request, Response } from 'express';
import pino from 'pino';
import { PcapUseCase } from '../../application/use-cases/pcap';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

// All endpoints require admin — captures can contain raw SIP/subscriber traffic,
// treated the same sensitivity level as subscriber records or config export.
export function createPcapRouter(pcapUseCase: PcapUseCase, auditLogger: IAuditLogger, logger: pino.Logger): Router {
  const router = Router();

  router.get('/interfaces', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const interfaces = await pcapUseCase.listInterfaces();
      res.json({ success: true, interfaces });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/nfs', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const nfs = await pcapUseCase.buildNfDescriptors();
      res.json({ success: true, nfs });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/presets', requireAdmin, (_req: Request, res: Response) => {
    res.json({ success: true, presets: pcapUseCase.presets() });
  });

  router.get('/captures', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const captures = await pcapUseCase.listCaptures();
      res.json({ success: true, captures });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/start', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const { interfaces, scope, label } = req.body ?? {};
      const manifest = await pcapUseCase.start({ interfaces, scope, label });
      await auditLogger.log({
        action: 'pcap_start', user, target: manifest.id,
        details: `interfaces=${manifest.interfaces.join(',')} scope=${manifest.scopeDescription}`,
        success: true,
      });
      res.json({ success: true, capture: manifest });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'pcap_start', user, details: error, success: false });
      res.status(400).json({ success: false, error });
    }
  });

  router.post('/stop/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { id } = req.params;
    try {
      const manifest = await pcapUseCase.stop(id);
      await auditLogger.log({ action: 'pcap_stop', user, target: id, success: true });
      res.json({ success: true, capture: manifest });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'pcap_stop', user, target: id, details: error, success: false });
      res.status(400).json({ success: false, error });
    }
  });

  router.get('/captures/:id/summary', requireAdmin, async (req: Request, res: Response) => {
    try {
      const summary = await pcapUseCase.getSummary(req.params.id);
      res.json({ success: true, summary });
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/captures/:id/packets', requireAdmin, async (req: Request, res: Response) => {
    try {
      const filter = typeof req.query.filter === 'string' ? req.query.filter : '';
      const result = await pcapUseCase.getPackets(req.params.id, filter);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/captures/:id/download', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { id } = req.params;
    try {
      const filePath = await pcapUseCase.getDownloadPath(id);
      res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
      res.setHeader('Content-Disposition', `attachment; filename="capture-${id}.pcapng"`);
      await auditLogger.log({ action: 'pcap_download', user, target: id, success: true });
      res.sendFile(filePath);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'pcap_download', user, target: id, details: error, success: false });
      res.status(404).json({ success: false, error });
    }
  });

  router.delete('/captures/:id', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { id } = req.params;
    try {
      await pcapUseCase.deleteCapture(id);
      await auditLogger.log({ action: 'pcap_delete', user, target: id, success: true });
      res.json({ success: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'pcap_delete', user, target: id, details: error, success: false });
      res.status(400).json({ success: false, error });
    }
  });

  pcapUseCase.reconcile().catch(err =>
    logger.error({ err: String(err) }, 'pcap: reconciliation failed'));

  return router;
}
