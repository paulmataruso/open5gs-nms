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
  getCscfAddresses,
  getSipTracingEnabled,
  getSipTracingRuntime,
  setSipTracingEnabled,
} from './ims-controller';
import { buildCallFlow, findRelatedCallIds } from '../../application/use-cases/sip-trace/call-flow';

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
        details: `needsConfigure=${report.needsConfigure} ${report.instances.map(i => `${i.role}:${i.action}`).join(' ')}`,
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
        // Only 'all' widens it; anything else (including absent) lists calls,
        // so a caller that has not thought about it gets the useful view.
        kind: q.kind === 'all' ? 'all' : 'calls',
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

  // The end-to-end ladder for a whole call. Separate from /messages, which
  // stays a faithful dump of the raw rows -- both views are wanted: the flow
  // to read the call, the raw list to audit what was actually captured.
  //
  // `related=1` pulls in other Call-IDs that look like the same real call, for
  // the B2BUA case where one call genuinely is two dialogs (see call-flow.ts).
  // Off by default: a heuristic merge should be asked for, not assumed.
  router.get('/calls/:callId/flow', async (req: Request, res: Response) => {
    try {
      const callId = req.params.callId;
      const ids = [callId];
      if (String(req.query.related ?? '') === '1') {
        ids.push(...(await findRelatedCallIds(db, callId)));
      }
      const batches = await Promise.all(ids.map(id => getCallMessages(db, id)));
      const messages = batches.flat();
      if (messages.length === 0) {
        res.status(404).json({ success: false, error: 'No messages for that Call-ID (it may have aged out)' });
        return;
      }
      const flow = buildCallFlow(messages, getCscfAddresses());
      // Offered even when not requested, so the UI can say how many related
      // dialogs exist without the operator having to guess and re-ask.
      const related = await findRelatedCallIds(db, callId);
      res.json({ success: true, flow, related, includedDialogs: ids });
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
