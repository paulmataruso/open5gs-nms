import { Router, Request, Response } from 'express';
import { Db } from 'mongodb';
import pino from 'pino';
import * as fs from 'fs';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { requireAdmin } from './middleware/auth-middleware';
import { HepCollector } from '../../application/use-cases/sip-trace/hep-collector';
import {
  CAPTURE_PORTS,
  DEFAULT_SIP_TRACE_RETENTION_HOURS,
  MAX_SIP_TRACE_RETENTION_HOURS,
  MIN_SIP_TRACE_RETENTION_HOURS,
  SipTraceSource,
  countMessages,
  ensureSipTraceIndexes,
  getCallMessages,
  listCalls,
} from '../../application/use-cases/sip-trace/sip-trace-store';
import {
  getSipTracingEnabled,
  getSipTracingRuntime,
  setSipTracingEnabled,
} from './ims-controller';

// Retention lives in its own tiny file rather than the IMS state blob: it is a
// property of this NMS's storage, not of the IMS deployment, and the collector
// needs it at startup before any IMS state is necessarily readable.
const SETTINGS_PATH = '/proc/1/root/etc/open5gs-nms/sip-trace-settings.json';

export interface SipTraceSettings {
  retentionHours: number;
}

export function readSipTraceSettings(): SipTraceSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    const h = Number(raw?.retentionHours);
    if (Number.isFinite(h) && h >= MIN_SIP_TRACE_RETENTION_HOURS && h <= MAX_SIP_TRACE_RETENTION_HOURS) {
      return { retentionHours: Math.round(h) };
    }
  } catch { /* missing or corrupt -- fall through to the default */ }
  return { retentionHours: DEFAULT_SIP_TRACE_RETENTION_HOURS };
}

function writeSipTraceSettings(s: SipTraceSettings): void {
  fs.mkdirSync('/proc/1/root/etc/open5gs-nms', { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

const asDate = (v: unknown): Date | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const SOURCES: SipTraceSource[] = ['pcscf', 'icscf', 'scscf', 'unknown'];

export function createSipTraceRouter(
  db: Db,
  collector: HepCollector,
  logger: pino.Logger,
  auditLogger: IAuditLogger,
): Router {
  const router = Router();

  // Status is intentionally readable by any authenticated user: it is how the
  // page explains why it is empty, and it exposes counters, not SIP content.
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [runtime, messages] = await Promise.all([
        getSipTracingRuntime().catch(() => []),
        countMessages(db).catch(() => 0),
      ]);
      res.json({
        success: true,
        enabled: getSipTracingEnabled(),
        collector: collector.getStats(),
        runtime,
        messages,
        capturePorts: CAPTURE_PORTS,
        settings: readSipTraceSettings(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/enable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const report = await setSipTracingEnabled(true);
      await auditLogger.log({
        action: 'sip_trace_enable',
        user,
        target: 'ims-cscf',
        details: `restarted=${report.restarted} ${report.instances.map(i => `${i.role}:${i.action}`).join(' ')}`,
        success: true,
      });
      res.json({ success: true, report });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err: error }, 'SIP tracing enable failed');
      await auditLogger.log({ action: 'sip_trace_enable', user, target: 'ims-cscf', details: error, success: false });
      res.status(500).json({ success: false, error });
    }
  });

  router.post('/disable', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    try {
      const report = await setSipTracingEnabled(false);
      await auditLogger.log({ action: 'sip_trace_disable', user, target: 'ims-cscf', success: true });
      res.json({ success: true, report });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'sip_trace_disable', user, target: 'ims-cscf', details: error, success: false });
      res.status(500).json({ success: false, error });
    }
  });

  router.get('/calls', async (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string>;
      const source = SOURCES.includes(q.source as SipTraceSource) ? (q.source as SipTraceSource) : undefined;
      const result = await listCalls(db, {
        from: asDate(q.from),
        to: asDate(q.to),
        search: q.search,
        method: q.method,
        source,
        page: q.page ? parseInt(q.page, 10) : undefined,
        pageSize: q.pageSize ? parseInt(q.pageSize, 10) : undefined,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/calls/:callId/messages', async (req: Request, res: Response) => {
    try {
      const messages = await getCallMessages(db, req.params.callId);
      if (messages.length === 0) {
        res.status(404).json({ success: false, error: 'No messages for that Call-ID (it may have aged out)' });
        return;
      }
      res.json({ success: true, messages });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/settings', async (_req: Request, res: Response) => {
    res.json({
      success: true,
      settings: readSipTraceSettings(),
      limits: { minHours: MIN_SIP_TRACE_RETENTION_HOURS, maxHours: MAX_SIP_TRACE_RETENTION_HOURS },
    });
  });

  router.post('/settings', requireAdmin, async (req: Request, res: Response) => {
    const user = (req as any).user?.username ?? 'unknown';
    const hours = Number((req.body ?? {}).retentionHours);
    if (!Number.isFinite(hours) || hours < MIN_SIP_TRACE_RETENTION_HOURS || hours > MAX_SIP_TRACE_RETENTION_HOURS) {
      res.status(400).json({
        success: false,
        error: `retentionHours must be between ${MIN_SIP_TRACE_RETENTION_HOURS} and ${MAX_SIP_TRACE_RETENTION_HOURS}`,
      });
      return;
    }
    try {
      const settings = { retentionHours: Math.round(hours) };
      writeSipTraceSettings(settings);
      // Applies to the existing TTL index too (collMod), so shortening
      // retention takes effect on already-stored messages rather than only on
      // new ones.
      await ensureSipTraceIndexes(db, settings.retentionHours);
      await auditLogger.log({ action: 'sip_trace_settings', user, target: `${settings.retentionHours}h`, success: true });
      res.json({ success: true, settings });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await auditLogger.log({ action: 'sip_trace_settings', user, target: String(hours), details: error, success: false });
      res.status(500).json({ success: false, error });
    }
  });

  return router;
}
