import { Router, Request, Response } from 'express';
import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';

const TLS_DIR  = '/etc/open5gs/tls';
const CERT_PATH = `${TLS_DIR}/sepp.crt`;
const KEY_PATH  = `${TLS_DIR}/sepp.key`;
const PEER_CACERT_PATH = `${TLS_DIR}/sepp-peer-ca.crt`;

export function createSeppRouter(
  hostExecutor: IHostExecutor,
  auditLogger: IAuditLogger,
  logger: pino.Logger,
): Router {
  const router = Router();

  // POST /api/sepp/generate-certs — self-signed cert+key for our home SEPP's N32
  // identity. Used directly as its own trust anchor (lab/test roaming setup, not a
  // real GSMA-IPX-backed PKI) — the visited operator saves the returned public cert
  // as their own cacert/verify_client_cacert file.
  router.post('/generate-certs', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { fqdn } = req.body ?? {};
    if (!fqdn || typeof fqdn !== 'string') {
      res.status(400).json({ success: false, error: 'fqdn is required' });
      return;
    }

    try {
      await hostExecutor.createDirectory(TLS_DIR);
      const result = await hostExecutor.executeCommand('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', KEY_PATH,
        '-out', CERT_PATH,
        '-days', '3650',
        '-subj', `/CN=${fqdn}`,
      ], 15000);

      if (result.exitCode !== 0) {
        throw new Error(`openssl exited ${result.exitCode}: ${result.stderr}`);
      }

      const cert = await hostExecutor.readFile(CERT_PATH);

      await auditLogger.log({
        action: 'sepp_generate_certs', user,
        details: `fqdn=${fqdn}`, success: true,
      });

      res.json({ success: true, cert });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg, fqdn }, 'SEPP cert generation failed');

      await auditLogger.log({
        action: 'sepp_generate_certs', user,
        details: `fqdn=${fqdn} error=${errMsg}`, success: false,
      });

      res.status(500).json({ success: false, error: errMsg });
    }
  });

  // GET /api/sepp/cert — return the existing public cert, if any, without regenerating
  router.get('/cert', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const exists = await hostExecutor.fileExists(CERT_PATH);
      if (!exists) {
        res.json({ success: true, exists: false });
        return;
      }
      const cert = await hostExecutor.readFile(CERT_PATH);
      res.json({ success: true, exists: true, cert });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: errMsg });
    }
  });

  // POST /api/sepp/peer-cert — save the visited-network peer SEPP's pasted public
  // cert (PEM), used as our own cacert/verify_client_cacert file (self-signed certs
  // used directly as their own trust anchor — see docs).
  router.post('/peer-cert', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const { cert } = req.body ?? {};
    if (!cert || typeof cert !== 'string' || !cert.includes('BEGIN CERTIFICATE')) {
      res.status(400).json({ success: false, error: 'A valid PEM certificate is required' });
      return;
    }
    try {
      await hostExecutor.createDirectory(TLS_DIR);
      await hostExecutor.writeFile(PEER_CACERT_PATH, cert);
      await auditLogger.log({ action: 'sepp_generate_certs', user, details: 'peer cacert saved', success: true });
      res.json({ success: true, path: PEER_CACERT_PATH });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: errMsg });
    }
  });

  // GET /api/sepp/peer-cert — return the existing peer cacert, if any
  router.get('/peer-cert', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const exists = await hostExecutor.fileExists(PEER_CACERT_PATH);
      if (!exists) {
        res.json({ success: true, exists: false });
        return;
      }
      const cert = await hostExecutor.readFile(PEER_CACERT_PATH);
      res.json({ success: true, exists: true, cert });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: errMsg });
    }
  });

  return router;
}
