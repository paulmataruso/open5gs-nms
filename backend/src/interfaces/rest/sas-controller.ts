import { Router, Request, Response } from 'express';
import pino from 'pino';
import * as fs from 'fs';
import { SasService } from '../../domain/sas/sas-service';
import { requireAdmin } from './middleware/auth-middleware';
import {
  RegistrationRequest, SpectrumInquiryRequest,
  GrantRequest, HeartbeatRequest,
  RelinquishmentRequest, DeregistrationRequest,
} from '../../domain/sas/sas-types';

// ─── SAS Protocol Router (unauthenticated — CBSDs connect directly) ────────────
// Contains ONLY the WInnForum CBSD protocol endpoints.
// Mounted at /sas with NO auth middleware in index.ts.
// Admin routes are intentionally excluded — they live in createSasAdminRouter.
export function createSasProtocolRouter(sas: SasService, logger: pino.Logger): Router {
  const router = Router();

  // Verbose toggle state — shared within this router instance only
  let sasVerbose = true;
  const setVerbose = (verbose: boolean) => {
    (logger as any).level = verbose ? 'trace' : 'info';
    if (verbose) {
      sas.stopSummaryLogger();
      logger.info({ sasVerbose: true }, 'SAS verbose logging ENABLED — all protocol messages visible, summary suppressed');
    } else {
      sas.startSummaryLogger(30_000);
      logger.info({ sasVerbose: false }, 'SAS verbose logging DISABLED — 30s summary only');
    }
  };
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

  return router;
}

// ─── SAS Admin Router (authenticated + admin-only) ─────────────────────────────
// All /admin/* routes. Mounted at /api/sas behind authMiddleware in index.ts.
// requireAdmin is applied to every mutating route.
export function createSasAdminRouter(sas: SasService, logger: pino.Logger, genieacsNbiUrl?: string): Router {
  const router = Router();

  let sasVerbose = true;
  const setVerbose = (verbose: boolean) => {
    (logger as any).level = verbose ? 'trace' : 'info';
    if (verbose) {
      sas.stopSummaryLogger();
      logger.info({ sasVerbose: true }, 'SAS verbose logging ENABLED');
    } else {
      sas.startSummaryLogger(30_000);
      logger.info({ sasVerbose: false }, 'SAS verbose logging DISABLED');
    }
  };

  // ── GET /api/sas/admin/last-requests ─────────────────────────────────────
  router.get('/admin/last-requests', (_req, res) => {
    res.json({ success: true, requests: sas.getLastRequests() });
  });

  // ── GET/POST /api/sas/admin/verbose ──────────────────────────────────────
  router.get('/admin/verbose', (_req, res) => {
    res.json({ success: true, verbose: sasVerbose });
  });
  router.post('/admin/verbose', requireAdmin, (req, res) => {
    sasVerbose = req.body?.verbose ?? !sasVerbose;
    setVerbose(sasVerbose);
    res.json({ success: true, verbose: sasVerbose });
  });

  // ── GET /api/sas/admin/logs ───────────────────────────────────────────────
  router.get('/admin/logs', async (req: Request, res: Response) => {
    const lines = Math.min(parseInt(req.query.lines as string ?? '200', 10), 2000);
    try {
      const { spawn }        = await import('child_process');
      const { promises: fsp } = await import('fs');

      let nginxLines: string[] = [];
      try {
        const raw = await fsp.readFile('/var/log/nginx-sas/sas-access.log', 'utf8');
        nginxLines = raw.split('\n').filter(l => l.trim()).slice(-lines).map(l => `[NGINX] ${l}`);
      } catch { /* file may not exist yet */ }

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

  // ── DELETE /api/sas/admin/grants/:grantId ────────────────────────────────
  router.delete('/admin/grants/:grantId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const deleted = await sas.deleteGrant(req.params.grantId);
      if (!deleted) return res.status(404).json({ success: false, error: 'Grant not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── DELETE /api/sas/admin/cbsds/:cbsdId ──────────────────────────────────
  router.delete('/admin/cbsds/:cbsdId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const deleted = await sas.deleteCbsd(req.params.cbsdId);
      if (!deleted) return res.status(404).json({ success: false, error: 'CBSD not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/sas/admin/cbsds ──────────────────────────────────────────────
  router.get('/admin/cbsds', async (_req: Request, res: Response) => {
    try {
      const cbsds  = await sas.listCbsds();
      const grants = await sas.listGrants();
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

  // ── GET /api/sas/admin/stats ──────────────────────────────────────────────
  router.get('/admin/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await sas.getStats();
      res.json({ success: true, ...stats });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/sas/admin/config ─────────────────────────────────────────────
  router.get('/admin/config', async (_req: Request, res: Response) => {
    try {
      const config = await sas.getConfig();
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── PUT /api/sas/admin/config ─────────────────────────────────────────────
  router.put('/admin/config', requireAdmin, async (req: Request, res: Response) => {
    try {
      const config = await sas.updateConfig(req.body);
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/sas/admin/reset ─────────────────────────────────────────────
  router.post('/admin/reset', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await sas.resetAll();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── POST /api/sas/admin/pause ─────────────────────────────────────────────
  router.post('/admin/pause', requireAdmin, (_req: Request, res: Response) => {
    sas.pauseSas();
    res.json({ success: true, paused: true });
  });

  // ── POST /api/sas/admin/resume ────────────────────────────────────────────
  router.post('/admin/resume', requireAdmin, (_req: Request, res: Response) => {
    sas.resumeSas();
    res.json({ success: true, paused: false });
  });

  // ── GET /api/sas/admin/status ─────────────────────────────────────────────
  router.get('/admin/status', (_req: Request, res: Response) => {
    res.json({ success: true, paused: sas.isPaused() });
  });

  // ── GET /api/sas/admin/rf-status ─────────────────────────────────────────
  router.get('/admin/rf-status', async (_req: Request, res: Response) => {
    try {
      const cbsds = await sas.listCbsds();

      if (!genieacsNbiUrl) {
        const status = await sas.getRfStatus();
        return res.json({ success: true, status });
      }

      // Separate maps per vendor — matching logic differs between them.
      const baiRfMap = new Map<string, boolean | null>(); // keyed by hwSerial == SAS cbsdSerialNumber
      const scRfMap  = new Map<string, boolean | null>(); // keyed by hwSerial; SAS serial is "Sercomm-<hwSerial>"
      const FAP = 'Device.Services.FAPService.1.';

      function getParam(device: Record<string, any>, dotPath: string): string {
        const parts = dotPath.split('.');
        let node: any = device;
        for (const part of parts) {
          if (node == null) return '';
          node = node[part];
        }
        return node?._value != null ? String(node._value) : '';
      }

      try {
        const baiProjection = ['_id', '_lastInform', '_deviceId', `${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`, `${FAP}FAPControl.LTE.OpState`].join(',');
        const baiResp = await fetch(`${genieacsNbiUrl}/devices?projection=${encodeURIComponent(baiProjection)}`);
        if (baiResp.ok) {
          const devices = (await baiResp.json()) as Record<string, any>[];
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          for (const d of devices) {
            const mfr = (d._deviceId?._Manufacturer ?? '').toLowerCase();
            const oui = (d._deviceId?._OUI ?? '').toUpperCase();
            if (!mfr.includes('baicells') && oui !== '48BF74') continue;
            const hwSerial   = (d._deviceId?._SerialNumber ?? d._id) as string;
            const lastInform = d._lastInform ?? null;
            const isOnline   = lastInform && lastInform > fiveMinAgo;
            const rfEnable   = getParam(d, `${FAP}CellConfig.LTE.RAN.RF.X_COM_RadioEnable`);
            const opState    = getParam(d, `${FAP}FAPControl.LTE.OpState`);
            baiRfMap.set(hwSerial, !isOnline ? null : (rfEnable === 'true' && opState === 'true'));
          }
        }
      } catch (e) { logger.warn({ err: String(e) }, 'rf-status: Baicells query failed'); }

      // Sercomm/Moso only — X_000E8F_eNB_Status is the authoritative RF indicator.
      // ACS hwSerial == _deviceId._SerialNumber (e.g. "2206CW5000768").
      // SAS cbsdSerialNumber format: "Sercomm-<hwSerial>".
      try {
        const scProjection = ['_id', '_lastInform', '_deviceId', 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status'].join(',');
        const scResp = await fetch(`${genieacsNbiUrl}/devices?projection=${encodeURIComponent(scProjection)}`);
        if (scResp.ok) {
          const devices = (await scResp.json()) as Record<string, any>[];
          const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          for (const d of devices) {
            const mfr = (d._deviceId?._Manufacturer ?? '').toLowerCase();
            const oui = (d._deviceId?._OUI ?? '').toUpperCase();
            if (!mfr.includes('sercomm') && !mfr.includes('freedomfi') && !mfr.includes('moso') && oui !== '000E8F') continue;
            const hwSerial   = (d._deviceId?._SerialNumber ?? d._id) as string;
            const lastInform = d._lastInform ?? null;
            const isOnline   = lastInform && lastInform > fiveMinAgo;
            const enbStatus  = getParam(d, 'Device.X_000E8F_DeviceFeature.X_000E8F_NEStatus.X_000E8F_eNB_Status');
            scRfMap.set(hwSerial, !isOnline ? null : (enbStatus.toUpperCase() === 'SUCCESS'));
          }
        }
      } catch (e) { logger.warn({ err: String(e) }, 'rf-status: Sercomm query failed'); }

      // Match each SAS CBSD to the right ACS RF reading.
      // Sercomm cbsdSerialNumber is "Sercomm-<hwSerial>"; Baicells cbsdSerialNumber IS the hwSerial.
      // Try scRfMap first using the last dash-delimited segment; fall back to baiRfMap with full serial.
      const status = cbsds.map(c => {
        let rfOn: boolean | null = null;
        const hwSerial = c.cbsdSerialNumber.split('-').pop()!;
        if (scRfMap.has(hwSerial)) {
          rfOn = scRfMap.get(hwSerial)!;
        } else if (baiRfMap.has(c.cbsdSerialNumber)) {
          rfOn = baiRfMap.get(c.cbsdSerialNumber)!;
        }
        return { cbsdId: c.cbsdId, serial: c.cbsdSerialNumber, fccId: c.fccId, rfOn };
      });

      res.json({ success: true, status });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/sas/admin/slots ──────────────────────────────────────────────
  router.get('/admin/slots', async (_req: Request, res: Response) => {
    try {
      const layout = await sas.getSlotLayout();
      res.json({ success: true, ...layout });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  // ── GET /api/sas/admin/cert ───────────────────────────────────────────────
  router.get('/admin/cert', async (_req: Request, res: Response) => {
    const certPath = '/etc/nginx/certs/sas.crt';
    try {
      const exists = fs.existsSync(certPath);
      if (!exists) return res.json({ exists: false, message: 'No certificate found. Run nginx/setup-sas-cert.sh to generate one.' });
      const stat = fs.statSync(certPath);
      res.json({ exists: true, size: stat.size, modified: stat.mtime });
    } catch (err) {
      res.json({ exists: false, message: String(err) });
    }
  });

  // ── GET /api/sas/admin/cert/download ─────────────────────────────────────
  router.get('/admin/cert/download', requireAdmin, async (_req: Request, res: Response) => {
    const certPath = '/etc/nginx/certs/sas.crt';
    try {
      if (!fs.existsSync(certPath)) return res.status(404).json({ error: 'Certificate not found.' });
      res.setHeader('Content-Type', 'application/x-pem-file');
      res.setHeader('Content-Disposition', 'attachment; filename="sas.crt"');
      res.sendFile(certPath);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Manual group assignments ──────────────────────────────────────────────
  router.get('/admin/manual-groups', async (_req, res) => {
    try { res.json({ success: true, groups: await sas.listManualGroups() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.put('/admin/manual-groups/:groupId', requireAdmin, async (req, res) => {
    try {
      const { cbsdIds } = req.body;
      if (!Array.isArray(cbsdIds)) return res.status(400).json({ success: false, error: 'cbsdIds array required' });
      const group = await sas.setManualGroup(req.params.groupId, cbsdIds);
      res.json({ success: true, group });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.delete('/admin/manual-groups/:groupId', requireAdmin, async (req, res) => {
    try { res.json({ success: true, deleted: await sas.deleteManualGroup(req.params.groupId) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  // ── Band policy endpoints ─────────────────────────────────────────────────
  router.get('/admin/policies/groups', async (_req, res) => {
    try { res.json({ success: true, policies: await sas.listGroupPolicies() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.put('/admin/policies/groups/:groupId', requireAdmin, async (req, res) => {
    try {
      const { bandId, notes, customSlots } = req.body;
      if (!bandId) return res.status(400).json({ success: false, error: 'bandId required' });
      const p = await sas.setGroupPolicy(req.params.groupId, bandId, notes, customSlots);
      res.json({ success: true, policy: p });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.delete('/admin/policies/groups/:groupId', requireAdmin, async (req, res) => {
    try { res.json({ success: true, deleted: await sas.deleteGroupPolicy(req.params.groupId) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.get('/admin/policies/cbsds', async (_req, res) => {
    try { res.json({ success: true, policies: await sas.listCbsdPolicies() }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.put('/admin/policies/cbsds/:fccId/:serial', requireAdmin, async (req, res) => {
    try {
      const { bandId, notes } = req.body;
      if (!bandId) return res.status(400).json({ success: false, error: 'bandId required' });
      const p = await sas.setCbsdPolicy(req.params.fccId, req.params.serial, bandId, notes);
      res.json({ success: true, policy: p });
    } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });
  router.delete('/admin/policies/cbsds/:fccId/:serial', requireAdmin, async (req, res) => {
    try { res.json({ success: true, deleted: await sas.deleteCbsdPolicy(req.params.fccId, req.params.serial) }); }
    catch (err) { res.status(500).json({ success: false, error: String(err) }); }
  });

  return router;
}
