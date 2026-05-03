import { Router, Request, Response } from 'express';
import { SubscriberManagementUseCase } from '../../application/use-cases/subscriber-management';
import { AutoAssignIPsUseCase } from '../../application/use-cases/auto-assign-ips-usecase';
import { requireAdmin } from './middleware/auth-middleware';
import pino from 'pino';

// CSV column order
const CSV_HEADERS = [
  'imsi', 'nickname', 'iccid', 'msisdn', 'ki', 'opc', 'amf',
  'sst', 'sd', 'apn', 'ue_ipv4',
];

function subscriberToRow(sub: any): string {
  const slice = sub.slice?.[0] ?? {};
  const session = slice.session?.[0] ?? {};
  const vals = [
    sub.imsi ?? '',
    sub.nickname ?? '',
    sub.iccid ?? '',
    (sub.msisdn ?? []).join('|'),
    sub.security?.k ?? '',
    sub.security?.opc ?? '',
    sub.security?.amf ?? '8000',
    slice.sst ?? '1',
    slice.sd ?? '',
    session.name ?? 'internet',
    session.ue?.ipv4 ?? '',
  ];
  return vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

function rowToSubscriber(headers: string[], values: string[]): any {
  const row: Record<string, string> = {};
  headers.forEach((h, i) => { row[h.trim().toLowerCase()] = (values[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"').trim(); });

  if (!row.imsi) throw new Error('IMSI is required');
  if (!row.ki)   throw new Error(`IMSI ${row.imsi}: ki is required`);
  if (!row.opc)  throw new Error(`IMSI ${row.imsi}: opc is required`);

  return {
    imsi: row.imsi,
    nickname: row.nickname || undefined,
    iccid:    row.iccid    || undefined,
    msisdn:   row.msisdn ? row.msisdn.split('|').filter(Boolean) : [],
    security: { k: row.ki, opc: row.opc, amf: row.amf || '8000' },
    slice: [{
      sst: parseInt(row.sst || '1'),
      sd:  row.sd  || undefined,
      default_indicator: true,
      session: [{
        name: row.apn || 'internet',
        type: 3,
        ambr: {
          uplink:   { value: 1, unit: 3 },
          downlink: { value: 1, unit: 3 },
        },
        ue: row.ue_ipv4 ? { ipv4: row.ue_ipv4 } : undefined,
        qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
      }],
    }],
  };
}

export function createSubscriberRouter(
  subscriberUC: SubscriberManagementUseCase,
  autoAssignIPsUC: AutoAssignIPsUseCase,
  logger: pino.Logger
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string | undefined;
      const result = search ? await subscriberUC.search(search, skip, limit) : await subscriberUC.list(skip, limit);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to list subscribers');
      res.status(500).json({ error: 'Failed to list subscribers' });
    }
  });

  // GET /api/subscribers/export?format=csv
  router.get('/export', async (req: Request, res: Response) => {
    try {
      const format = (req.query.format as string) === 'tsv' ? 'tsv' : 'csv';
      const sep = format === 'tsv' ? '\t' : ',';
      const filename = `subscribers-${new Date().toISOString().slice(0, 10)}.${format}`;

      let all: any[] = [];
      let skip = 0;
      while (true) {
        const page = await subscriberUC.list(skip, 200);
        const subs = page.subscribers ?? [];
        if (subs.length === 0) break;
        for (const s of subs) {
          const full = await subscriberUC.getByImsi(s.imsi);
          if (full) all.push(full);
        }
        if (subs.length < 200) break;
        skip += 200;
      }

      const header = CSV_HEADERS.join(sep);
      const rows = all.map(s => subscriberToRow(s));
      const body = [header, ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(body);
    } catch (err) {
      logger.error({ err }, 'Export failed');
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // POST /api/subscribers/import (admin only)
  router.post('/import', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { csv, mode = 'skip' } = req.body;
      if (!csv || typeof csv !== 'string') {
        res.status(400).json({ error: 'csv field required' }); return;
      }
      const lines = csv.split(/\r?\n/).filter((l: string) => l.trim());
      if (lines.length < 2) {
        res.status(400).json({ error: 'CSV must have a header row and at least one data row' }); return;
      }
      const sep = lines[0].includes('\t') ? '\t' : ',';
      const headers = lines[0].split(sep);
      let imported = 0, skipped = 0, overwritten = 0;
      const errors: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        try {
          const sub = rowToSubscriber(headers, lines[i].split(sep));
          const existing = await subscriberUC.getByImsi(sub.imsi);
          if (existing) {
            if (mode === 'overwrite') { await subscriberUC.update(sub.imsi, sub); overwritten++; }
            else skipped++;
          } else {
            await subscriberUC.create(sub); imported++;
          }
        } catch (err) {
          errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      res.json({ success: true, imported, skipped, overwritten, errors });
    } catch (err) {
      logger.error({ err }, 'Import failed');
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // Get IP assignments for all subscribers (MUST be before /:imsi route)
  router.get('/ip-assignments', async (req: Request, res: Response) => {
    try {
      const assignments = await autoAssignIPsUC.getIPAssignments();
      res.json({
        success: true,
        data: assignments,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get IP assignments');
      res.status(500).json({ success: false, error: 'Failed to get IP assignments' });
    }
  });

  router.get('/:imsi', async (req: Request, res: Response) => {
    try {
      const subscriber = await subscriberUC.getByImsi(req.params.imsi);
      if (!subscriber) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(subscriber);
    } catch (err) {
      logger.error({ err }, 'Failed to get subscriber');
      res.status(500).json({ error: 'Failed to get subscriber' });
    }
  });

  router.post('/', requireAdmin, async (req: Request, res: Response) => {
    try {
      await subscriberUC.create(req.body);
      res.status(201).json({ message: 'Created' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.put('/:imsi', requireAdmin, async (req: Request, res: Response) => {
    try {
      await subscriberUC.update(req.params.imsi, req.body);
      res.json({ message: 'Updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/:imsi', requireAdmin, async (req: Request, res: Response) => {
    try {
      await subscriberUC.delete(req.params.imsi);
      res.json({ message: 'Deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.post('/auto-assign-ips', requireAdmin, async (req: Request, res: Response) => {
    try {
      logger.info('Auto-assigning IPs to all subscribers');
      const result = await autoAssignIPsUC.execute();
      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to auto-assign IPs');
      const msg = err instanceof Error ? err.message : 'Failed to auto-assign IPs';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
