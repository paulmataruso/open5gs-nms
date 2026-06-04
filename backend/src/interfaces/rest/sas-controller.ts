import { Router, Request, Response } from 'express';
import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { SasService } from '../../domain/sas/sas-service';
import {
  RegistrationRequest, SpectrumInquiryRequest,
  GrantRequest, HeartbeatRequest,
  RelinquishmentRequest, DeregistrationRequest,
} from '../../domain/sas/sas-types';

export function createSasRouter(sas: SasService, logger: pino.Logger): Router {
  const router = Router();

  // Runtime verbose toggle — raises sasLogger level to 'trace' (shows all) or 'info' (summary only)
  // When verbose=false: trace level logs are suppressed (docker compose is quiet)
  // When verbose=true:  trace level logs appear — ALL SAS protocol messages visible
  const setVerbose = (verbose: boolean) => {
    (logger as any).level = verbose ? 'trace' : 'info';
    if (verbose) {
      // Stop the summary logger — let every individual SAS message through instead
      sas.stopSummaryLogger();
      logger.info({ sasVerbose: true }, 'SAS verbose logging ENABLED — all protocol messages visible, summary suppressed');
    } else {
      // Restart the summary logger — quiet mode
      sas.startSummaryLogger(30_000);
      logger.info({ sasVerbose: false }, 'SAS verbose logging DISABLED — 30s summary only');
    }
  };
  let sasVerbose = true;

  // Set verbose on by default at startup
  setVerbose(true);

  // ── POST /sas/v1.2/registration ──────────────────────────────────────────
  router.post('/v1.2/registration', async (req: Request, res: Response) => {
    if (sas.isPaused()) return res.json({ registrationResponse: [{ response: { responseCode: 105, responseMessage: 'DEREGISTER' } }] });
    logger.info({ body: req.body, ip: req.ip, headers: req.headers }, 'SAS registration request');
    try {
      const requests: RegistrationRequest[] = req.body?.registrationRequest;
      if (!Array.isArray(requests) || requests.length === 0) {
        logger.warn({ body: req.body }, 'SAS registration: missing registrationRequest array');
        return res.status(400).json({ registrationResponse: [] });
      }
      const registrationResponse = await sas.registration(requests);
      logger.info({ registrationResponse }, 'SAS registration response');
      res.json({ registrationResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS registration error');
      res.status(500).json({ registrationResponse: [] });
    }
  });

  // ── POST /sas/v1.2/spectrumInquiry ───────────────────────────────────────
  router.post('/v1.2/spectrumInquiry', async (req: Request, res: Response) => {
    if (sas.isPaused()) return res.json({ spectrumInquiryResponse: [{ response: { responseCode: 105, responseMessage: 'DEREGISTER' } }] });
    logger.trace({ body: req.body, ip: req.ip }, 'SAS spectrumInquiry request');
    try {
      const requests: SpectrumInquiryRequest[] = req.body?.spectrumInquiryRequest;
      const clientIp = req.ip ?? '';
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ spectrumInquiryResponse: [] });
      }
      // Tag each request with the client IP so the debug view can show it
      for (const r of requests) {
        if (r.cbsdId) {
          const cbsds = await sas.listCbsds();
          const cbsd  = cbsds.find(c => c.cbsdId === r.cbsdId);
          if (cbsd && r.inquiredSpectrum?.[0]) {
            const fr = r.inquiredSpectrum[0];
            sas.recordLastRequest(r.cbsdId, cbsd.cbsdSerialNumber, cbsd.fccId, clientIp, fr.lowFrequency, fr.highFrequency, 'spectrumInquiry');
          }
        }
      }
      const spectrumInquiryResponse = await sas.spectrumInquiry(requests);
      logger.trace({ spectrumInquiryResponse }, 'SAS spectrumInquiry response');
      res.json({ spectrumInquiryResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS spectrumInquiry error');
      res.status(500).json({ spectrumInquiryResponse: [] });
    }
  });

  // ── POST /sas/v1.2/grant ─────────────────────────────────────────────────
  router.post('/v1.2/grant', async (req: Request, res: Response) => {
    if (sas.isPaused()) return res.json({ grantResponse: [{ response: { responseCode: 105, responseMessage: 'DEREGISTER' } }] });
    try {
      const requests: GrantRequest[] = req.body?.grantRequest;
      const clientIp = req.ip ?? '';
      logger.trace({ RAW_REQUEST: req.body, ip: clientIp }, 'SAS /grant RAW');
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ grantResponse: [] });
      }
      // Tag each request with the client IP for the debug view
      for (const r of requests) {
        if (r.cbsdId && r.operationParam?.operationFrequencyRange) {
          const cbsds = await sas.listCbsds();
          const cbsd  = cbsds.find(c => c.cbsdId === r.cbsdId);
          if (cbsd) {
            const { lowFrequency, highFrequency } = r.operationParam.operationFrequencyRange;
            sas.recordLastRequest(r.cbsdId, cbsd.cbsdSerialNumber, cbsd.fccId, clientIp, lowFrequency, highFrequency, 'grant');
          }
        }
      }
      const grantResponse = await sas.grant(requests);
      logger.trace({ RAW_RESPONSE: { grantResponse } }, 'SAS /grant RAW response');
      res.json({ grantResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS grant error');
      res.status(500).json({ grantResponse: [] });
    }
  });

  // ── POST /sas/v1.2/heartbeat ─────────────────────────────────────────────
  router.post('/v1.2/heartbeat', async (req: Request, res: Response) => {
    if (sas.isPaused()) return res.json({ heartbeatResponse: [{ transmitExpireTime: new Date().toISOString(), response: { responseCode: 500, responseMessage: 'TERMINATED_GRANT' } }] });
    try {
      const requests: HeartbeatRequest[] = req.body?.heartbeatRequest;
      logger.trace({ RAW_REQUEST: req.body, ip: req.ip }, 'SAS /heartbeat RAW');
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ heartbeatResponse: [] });
      }
      const heartbeatResponse = await sas.heartbeat(requests);
      logger.trace({ RAW_RESPONSE: { heartbeatResponse } }, 'SAS /heartbeat RAW response');
      res.json({ heartbeatResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS heartbeat error');
      res.status(500).json({ heartbeatResponse: [] });
    }
  });

  // ── POST /sas/v1.2/relinquishment ────────────────────────────────────────
  router.post('/v1.2/relinquishment', async (req: Request, res: Response) => {
    logger.info({ body: req.body, ip: req.ip }, 'SAS relinquishment request');
    try {
      const requests: RelinquishmentRequest[] = req.body?.relinquishmentRequest;
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ relinquishmentResponse: [] });
      }
      const relinquishmentResponse = await sas.relinquishment(requests);
      logger.info({ relinquishmentResponse }, 'SAS relinquishment response');
      res.json({ relinquishmentResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS relinquishment error');
      res.status(500).json({ relinquishmentResponse: [] });
    }
  });

  // ── POST /sas/v1.2/deregistration ────────────────────────────────────────
  router.post('/v1.2/deregistration', async (req: Request, res: Response) => {
    logger.info({ body: req.body, ip: req.ip }, 'SAS deregistration request');
    try {
      const requests: DeregistrationRequest[] = req.body?.deregistrationRequest;
      if (!Array.isArray(requests) || requests.length === 0) {
        return res.status(400).json({ deregistrationResponse: [] });
      }
      const deregistrationResponse = await sas.deregistration(requests);
      logger.info({ deregistrationResponse }, 'SAS deregistration response');
      res.json({ deregistrationResponse });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS deregistration error');
      res.status(500).json({ deregistrationResponse: [] });
    }
  });

  // ── GET /sas/admin/last-requests — last freq request per CBSD (debug) ──────────
  router.get('/admin/last-requests', (_req, res) => {
    res.json({ success: true, requests: sas.getLastRequests() });
  });

  // ── GET/POST /sas/admin/verbose — toggle verbose SAS protocol logging ──────
  router.get('/admin/verbose', (_req, res) => {
    res.json({ success: true, verbose: sasVerbose });
  });
  router.post('/admin/verbose', (req, res) => {
    sasVerbose = req.body?.verbose ?? !sasVerbose;
    setVerbose(sasVerbose);
    res.json({ success: true, verbose: sasVerbose });
  });

  // ── GET /sas/admin/logs ───────────────────────────────────────────────────
  // Merges nginx SAS access log + backend structured SAS logs into one stream
  router.get('/admin/logs', async (req: Request, res: Response) => {
    const lines = Math.min(parseInt(req.query.lines as string ?? '200', 10), 2000);
    try {
      const { spawn }  = await import('child_process');
      const { promises: fs } = await import('fs');

      // 1 — Nginx SAS access log (mounted at /var/log/nginx-sas/sas-access.log)
      let nginxLines: string[] = [];
      try {
        const raw = await fs.readFile('/var/log/nginx-sas/sas-access.log', 'utf8');
        nginxLines = raw.split('\n')
          .filter(l => l.trim())
          .slice(-lines)
          .map(l => `[NGINX] ${l}`);
      } catch { /* file may not exist yet */ }

      // 2 — Backend structured SAS logs from docker
      const dockerRaw = await new Promise<string>((resolve) => {
        const args = ['logs', '--timestamps', '--tail', String(lines * 4), 'open5gs-nms-backend'];
        const proc = spawn('docker', args);
        let out = '';
        proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        proc.on('close', () => resolve(out));
        proc.on('error', () => resolve(''));
      });

      const backendLines = dockerRaw
        .split('\n')
        .filter(l => /SAS|sas\/v1\.2|registrationRequest|grantRequest|heartbeatRequest|spectrumInquiry|relinquishment|deregistration/i.test(l))
        .slice(-lines)
        .map(l => `[BACKEND] ${l}`);

      // 3 — Merge and sort by timestamp (both start with ISO timestamp)
      const merged = [...nginxLines, ...backendLines]
        .sort((a, b) => {
          const ta = a.match(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/);
          const tb = b.match(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/);
          if (!ta || !tb) return 0;
          return ta[0].localeCompare(tb[0]);
        })
        .slice(-lines)
        .join('\n');

      res.json({ success: true, logs: merged });
    } catch (err) {
      logger.error({ err: String(err) }, 'SAS log fetch failed');
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── DELETE /sas/admin/grants/:grantId ─────────────────────────────────────
  router.delete('/admin/grants/:grantId', async (req: Request, res: Response) => {
    try {
      const deleted = await sas.deleteGrant(req.params.grantId);
      if (!deleted) return res.status(404).json({ success: false, error: 'Grant not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── DELETE /sas/admin/cbsds/:cbsdId ─────────────────────────────────────
  router.delete('/admin/cbsds/:cbsdId', async (req: Request, res: Response) => {
    try {
      const deleted = await sas.deleteCbsd(req.params.cbsdId);
      if (!deleted) return res.status(404).json({ success: false, error: 'CBSD not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /sas/admin/cbsds ─────────────────────────────────────────────────
  router.get('/admin/cbsds', async (_req: Request, res: Response) => {
    try {
      const cbsds  = await sas.listCbsds();
      const grants = await sas.listGrants();
      // Attach grants to each CBSD
      const grantsByCbsd = grants.reduce((acc, g) => {
        (acc[g.cbsdId] ??= []).push(g);
        return acc;
      }, {} as Record<string, typeof grants>);
      const data = cbsds.map(c => ({ ...c, grants: grantsByCbsd[c.cbsdId] ?? [] }));
      res.json({ success: true, cbsds: data });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /sas/admin/stats ──────────────────────────────────────────────────
  router.get('/admin/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await sas.getStats();
      res.json({ success: true, ...stats });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /sas/admin/config ─────────────────────────────────────────────────
  router.get('/admin/config', async (_req: Request, res: Response) => {
    try {
      const config = await sas.getConfig();
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── PUT /sas/admin/config ─────────────────────────────────────────────────
  router.put('/admin/config', async (req: Request, res: Response) => {
    try {
      const config = await sas.updateConfig(req.body);
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /sas/admin/reset ────────────────────────────────────────────
  // Deletes all grants + CBSDs. Does NOT touch radios or ACS.
  router.post('/admin/reset', async (_req: Request, res: Response) => {
    try {
      const result = await sas.resetAll();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /sas/admin/pause ────────────────────────────────────────────
  // Pauses the SAS — all protocol endpoints return DEREGISTER/TERMINATED.
  // Radios stop transmitting and wait. No data is deleted.
  router.post('/admin/pause', (_req: Request, res: Response) => {
    sas.pauseSas();
    res.json({ success: true, paused: true });
  });

  // ── POST /sas/admin/resume ───────────────────────────────────────────
  router.post('/admin/resume', (_req: Request, res: Response) => {
    sas.resumeSas();
    res.json({ success: true, paused: false });
  });

  // ── GET /sas/admin/status ────────────────────────────────────────────
  router.get('/admin/status', (_req: Request, res: Response) => {
    res.json({ success: true, paused: sas.isPaused() });
  });

  // ── GET /sas/admin/slots ─────────────────────────────────────────────
  router.get('/admin/slots', async (_req: Request, res: Response) => {
    try {
      const layout = await sas.getSlotLayout();
      res.json({ success: true, ...layout });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /sas/admin/cert — cert info and download link ──────────────────────
  router.get('/admin/cert', async (req: Request, res: Response) => {
    const certPath = '/etc/nginx/certs/sas.crt';
    try {
      const exists = fs.existsSync(certPath);
      if (!exists) {
        return res.json({ exists: false, message: 'No certificate found. Run nginx/setup-sas-cert.sh to generate one.' });
      }
      const stat = fs.statSync(certPath);
      res.json({ exists: true, size: stat.size, modified: stat.mtime });
    } catch (err) {
      res.json({ exists: false, message: String(err) });
    }
  });

  // ── GET /sas/admin/cert/download — download the SAS cert file ────────────────
  router.get('/admin/cert/download', async (req: Request, res: Response) => {
    const certPath = '/etc/nginx/certs/sas.crt';
    try {
      if (!fs.existsSync(certPath)) {
        return res.status(404).json({ error: 'Certificate not found. Run nginx/setup-sas-cert.sh first.' });
      }
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', 'attachment; filename="sas.crt"');
      res.sendFile(certPath);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Band Policy endpoints ─────────────────────────────────────────────────────────
  router.get('/admin/policies/groups', async (_req, res) => {
    try { res.json({ success: true, policies: await sas.listGroupPolicies() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.put('/admin/policies/groups/:groupId', async (req, res) => {
    try {
      const { bandId, notes, customSlots } = req.body;
      if (!bandId) return res.status(400).json({ success: false, error: 'bandId required' });
      const p = await sas.setGroupPolicy(req.params.groupId, bandId, notes, customSlots);
      res.json({ success: true, policy: p });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.delete('/admin/policies/groups/:groupId', async (req, res) => {
    try { res.json({ success: true, deleted: await sas.deleteGroupPolicy(req.params.groupId) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.get('/admin/policies/cbsds', async (_req, res) => {
    try { res.json({ success: true, policies: await sas.listCbsdPolicies() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.put('/admin/policies/cbsds/:fccId/:serial', async (req, res) => {
    try {
      const { bandId, notes } = req.body;
      if (!bandId) return res.status(400).json({ success: false, error: 'bandId required' });
      const p = await sas.setCbsdPolicy(req.params.fccId, req.params.serial, bandId, notes);
      res.json({ success: true, policy: p });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.delete('/admin/policies/cbsds/:fccId/:serial', async (req, res) => {
    try { res.json({ success: true, deleted: await sas.deleteCbsdPolicy(req.params.fccId, req.params.serial) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  return router;
}
