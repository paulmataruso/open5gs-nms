import { Router, Request, Response } from 'express';
import pino from 'pino';
import { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';

type Resolution = '5m' | '15m' | '1h';
type Generation = '2g' | '4g' | '5g';

// Also valid PromQL duration literals — used directly as the rate() window.
const RESOLUTION_STEP_SECONDS: Record<Resolution, number> = { '5m': 300, '15m': 900, '1h': 3600 };

interface PromMatrixSeries {
  metric: Record<string, string>;
  values: [number, string][];
}

async function promQueryRange(
  prometheusUrl: string,
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<PromMatrixSeries[]> {
  const url = new URL('/api/v1/query_range', prometheusUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(startSec));
  url.searchParams.set('end', String(endSec));
  url.searchParams.set('step', String(stepSec));

  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`Prometheus query_range failed: HTTP ${response.status}`);
  }
  const body: any = await response.json();
  if (body.status !== 'success' || body.data?.resultType !== 'matrix') {
    throw new Error(`Unexpected Prometheus response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data.result as PromMatrixSeries[];
}

async function promInstantQuery(prometheusUrl: string, query: string): Promise<Record<string, string>[]> {
  const url = new URL('/api/v1/query', prometheusUrl);
  url.searchParams.set('query', query);
  const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Prometheus query failed: HTTP ${response.status}`);
  const body: any = await response.json();
  if (body.status !== 'success' || body.data?.resultType !== 'vector') {
    throw new Error(`Unexpected Prometheus response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return (body.data.result as Array<{ metric: Record<string, string> }>).map(r => r.metric);
}

// Resolves the "radio" and/or "generation" (4g/5g only — 2g is a metric-
// family switch handled separately, not a narrowing filter) request params
// into a set of matching IMSIs via the shared open5gs_radio_info gauge —
// same join mechanism the Grafana dashboard uses via `and on(imsi)`, just
// resolved server-side here since building that join inside a PromQL string
// assembled from request params is harder to keep safe/correct than doing
// the join in one small extra query. Returns null when neither filter is
// set (no narrowing requested at all).
// Returns each matched imsi alongside its own ran_generation label, not just a bare
// imsi list — real bug, confirmed live 2026-09-29 during a full-session wiring audit:
// a radio selection with RAN Type left at "All" (no explicit generation) has no other
// way to know which metric family (4g/5g-native vs. 2g's own separate counters) that
// radio's subscribers actually belong to, and the caller was previously always
// defaulting to the 4g/5g family regardless — a 2G radio's own traffic silently never
// appeared. See this function's own caller for how ran_generation is used.
async function resolveImsisByRadioOrGeneration(
  prometheusUrl: string,
  radio: string | undefined,
  generation: '4g' | '5g' | undefined,
): Promise<{ imsi: string; ranGeneration: string }[] | null> {
  if (!radio && !generation) return null;
  const matchers: string[] = [];
  if (radio) matchers.push(`radio_name="${radio}"`);
  if (generation) matchers.push(`ran_generation="${generation}"`);
  const rows = await promInstantQuery(prometheusUrl, `open5gs_radio_info{${matchers.join(',')}}`);
  return rows.filter(m => m.imsi).map(m => ({ imsi: m.imsi, ranGeneration: m.ran_generation }));
}

export const createTrafficHistoryRouter = (
  prometheusUrl: string,
  subscriberRepo: ISubscriberRepository,
  logger: pino.Logger,
): Router => {
  const router = Router();

  // ── GET / — time series points for charting, proxied from Prometheus ────────
  router.get('/', async (req: Request, res: Response) => {
    try {
      const scope = (req.query.scope as string) === 'subscriber' ? 'subscriber' : 'aggregate';
      const resolution = ((req.query.resolution as string) ?? '5m') as Resolution;
      const step = RESOLUTION_STEP_SECONDS[resolution];
      if (!step) {
        res.status(400).json({ error: 'resolution must be one of 5m, 15m, 1h' });
        return;
      }

      const imsi = req.query.imsi as string | undefined;
      const dnn = req.query.dnn as string | undefined;
      const radio = req.query.radio as string | undefined;
      const generationParam = req.query.generation as string | undefined;
      const generation: Generation | undefined = generationParam === '2g' || generationParam === '4g' || generationParam === '5g' ? generationParam : undefined;
      if (scope === 'subscriber' && !imsi && !radio && !generation) {
        res.status(400).json({ error: 'imsi is required when scope=subscriber, unless radio or generation is set' });
        return;
      }
      // Radio and 4g/5g-generation narrowing only mean anything for
      // per-subscriber series — the DNN/APN aggregate counters have no imsi
      // dimension to join against (one shared tun device per DNN/APN, not
      // one per radio — a structural limit, not a gap in this endpoint).
      if (scope === 'aggregate' && (radio || (generation && generation !== '2g'))) {
        res.status(400).json({ error: 'radio and generation=4g/5g filters only apply to scope=subscriber; aggregate has no per-radio breakdown' });
        return;
      }

      const to = req.query.to ? new Date(req.query.to as string) : new Date();
      const from = req.query.from ? new Date(req.query.from as string) : new Date(to.getTime() - 24 * 60 * 60 * 1000);
      const startSec = Math.floor(from.getTime() / 1000);
      const endSec = Math.floor(to.getTime() / 1000);

      // generation=2g switches to the 2G GPRS/EDGE metric family entirely
      // (its own separate counters — 2G traffic never touches Open5GS's own
      // UPF/SMF). generation=4g/5g does NOT switch metrics — it narrows
      // WHICH imsis are queried within the existing (today: 4G/5G-only)
      // family, via the resolver above.
      let is2g = generation === '2g';

      let labelFilter: string;
      if (scope === 'subscriber') {
        if (radio || generation === '4g' || generation === '5g') {
          // Not gated on `!is2g` — real bug, confirmed live 2026-09-29: a radio
          // filter must still resolve when generation=2g is ALSO selected (it
          // used to be dropped entirely, silently falling through to "every 2G
          // subscriber" instead of the chosen radio's own).
          const matched = await resolveImsisByRadioOrGeneration(prometheusUrl, radio, generation === '4g' || generation === '5g' ? generation : undefined);
          const rows = matched ?? [];
          const candidateRows = imsi ? rows.filter(m => m.imsi === imsi) : rows;
          if (candidateRows.length === 0) {
            // Honest empty result — a real, valid outcome (e.g. no
            // subscriber currently on the chosen radio), not an error.
            res.json({ points: [] });
            return;
          }
          // No explicit generation was given but a specific radio was — infer
          // is2g from what that radio's own resolved subscribers actually are,
          // rather than defaulting to the 4g/5g family regardless (the other
          // real bug this same audit found: picking a 2G radio with RAN Type
          // left at "All" silently queried the wrong metric family and always
          // came back empty). A radio serves exactly one generation in this
          // project's own data model, so this is never actually ambiguous.
          if (!generation) is2g = candidateRows.every(r => r.ranGeneration === '2g');
          labelFilter = `{imsi=~"${candidateRows.map(r => r.imsi).join('|')}"}`;
        } else if (imsi) {
          labelFilter = `{imsi="${imsi}"}`;
        } else {
          // generation=2g with no specific imsi chosen — every 2G subscriber.
          labelFilter = '';
        }
      } else {
        const aggLabel = is2g ? 'apn' : 'dnn';
        labelFilter = dnn ? `{${aggLabel}="${dnn}"}` : '';
      }

      const upMetric = is2g
        ? (scope === 'subscriber' ? 'open5gs_gsm2g_subscriber_up_bytes_total' : 'open5gs_gsm2g_gtp_rx_bytes_total')
        : (scope === 'subscriber' ? 'open5gs_subscriber_up_bytes_total' : 'open5gs_gtp_rx_bytes_total');
      const downMetric = is2g
        ? (scope === 'subscriber' ? 'open5gs_gsm2g_subscriber_down_bytes_total' : 'open5gs_gsm2g_gtp_tx_bytes_total')
        : (scope === 'subscriber' ? 'open5gs_subscriber_down_bytes_total' : 'open5gs_gtp_tx_bytes_total');

      const [upResult, downResult] = await Promise.all([
        promQueryRange(prometheusUrl, `rate(${upMetric}${labelFilter}[${resolution}])*8/1e6`, startSec, endSec, step),
        promQueryRange(prometheusUrl, `rate(${downMetric}${labelFilter}[${resolution}])*8/1e6`, startSec, endSec, step),
      ]);

      // Merge up+down series keyed by (ts, dnn|imsi) back into one point per series/timestamp.
      const byKey = new Map<string, { ts: number; dnn?: string; imsi?: string; upMbps: number; downMbps: number }>();
      const labelOf = (metric: Record<string, string>) => (scope === 'subscriber' ? metric.imsi : (metric.dnn ?? metric.apn));

      for (const series of upResult) {
        const label = labelOf(series.metric);
        for (const [ts, val] of series.values) {
          const key = `${ts}|${label ?? ''}`;
          const point = byKey.get(key) ?? {
            ts, upMbps: 0, downMbps: 0,
            ...(scope === 'subscriber' ? { imsi: label } : { dnn: label }),
          };
          point.upMbps = Number(val);
          byKey.set(key, point);
        }
      }
      for (const series of downResult) {
        const label = labelOf(series.metric);
        for (const [ts, val] of series.values) {
          const key = `${ts}|${label ?? ''}`;
          const point = byKey.get(key) ?? {
            ts, upMbps: 0, downMbps: 0,
            ...(scope === 'subscriber' ? { imsi: label } : { dnn: label }),
          };
          point.downMbps = Number(val);
          byKey.set(key, point);
        }
      }

      const points = Array.from(byKey.values())
        .sort((a, b) => a.ts - b.ts)
        .map(p => ({
          ts: new Date(p.ts * 1000).toISOString(),
          dnn: p.dnn,
          imsi: p.imsi,
          upMbps: Number.isFinite(p.upMbps) ? p.upMbps : 0,
          downMbps: Number.isFinite(p.downMbps) ? p.downMbps : 0,
        }));

      res.json({ points });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to query traffic history from Prometheus');
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /period-summary — total data volume per day/week/month, for the
  // per-UE "usage over time" view. Uses PromQL increase() (total counter
  // growth over each window), not rate() — this endpoint answers "how many
  // bytes" per period, not "how many Mbps" at an instant, so it deliberately
  // does NOT reuse the '/' endpoint's rate()-based query. 'month' is
  // approximated as a fixed 30d window (PromQL has no calendar-month
  // duration literal) — acceptable here since Prometheus's own retention is
  // 30 days anyway (see CLAUDE.md), so a precise calendar month rarely
  // matters in practice. query_range's own step==window-size gives
  // non-overlapping buckets, one point per period.
  router.get('/period-summary', async (req: Request, res: Response) => {
    try {
      const imsi = req.query.imsi as string | undefined;
      if (!imsi) {
        res.status(400).json({ error: 'imsi is required' });
        return;
      }
      const generation = (req.query.generation as string) === '2g' ? '2g' : undefined;
      const period = (req.query.period as string) === 'week' ? 'week'
        : (req.query.period as string) === 'month' ? 'month' : 'day';
      const periodSeconds = period === 'week' ? 7 * 24 * 3600 : period === 'month' ? 30 * 24 * 3600 : 24 * 3600;
      const rangeLit = period === 'week' ? '7d' : period === 'month' ? '30d' : '1d';
      const count = Math.min(Math.max(Number(req.query.count) || 14, 1), 90);

      const endSec = Math.floor(Date.now() / 1000);
      const startSec = endSec - periodSeconds * count;
      const labelFilter = `{imsi="${imsi}"}`;
      const upMetric = generation === '2g' ? 'open5gs_gsm2g_subscriber_up_bytes_total' : 'open5gs_subscriber_up_bytes_total';
      const downMetric = generation === '2g' ? 'open5gs_gsm2g_subscriber_down_bytes_total' : 'open5gs_subscriber_down_bytes_total';

      const [upResult, downResult] = await Promise.all([
        promQueryRange(prometheusUrl, `increase(${upMetric}${labelFilter}[${rangeLit}])`, startSec, endSec, periodSeconds),
        promQueryRange(prometheusUrl, `increase(${downMetric}${labelFilter}[${rangeLit}])`, startSec, endSec, periodSeconds),
      ]);

      const byTs = new Map<number, number>();
      for (const series of upResult) {
        for (const [ts, val] of series.values) byTs.set(ts, (byTs.get(ts) ?? 0) + Number(val));
      }
      for (const series of downResult) {
        for (const [ts, val] of series.values) byTs.set(ts, (byTs.get(ts) ?? 0) + Number(val));
      }

      const points = Array.from(byTs.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, bytes]) => ({
          periodStart: new Date(ts * 1000).toISOString(),
          bytes: Number.isFinite(bytes) ? Math.max(bytes, 0) : 0,
        }));

      res.json({ period, points });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to query period summary from Prometheus');
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /subscribers — IMSIs currently tracked, for the filter dropdown ─────
  // Known, pre-existing limitation (unrelated to this feature, not fixed
  // here): label/imsi/values with no start/end returns every IMSI ever seen
  // across Prometheus's full 30-day retention, not just currently-active
  // ones — a decommissioned subscriber can linger in this dropdown for up
  // to 30 days. Left as-is; the new /radios endpoint below deliberately
  // does NOT repeat this by bounding its own query window instead.
  router.get('/subscribers', async (_req: Request, res: Response) => {
    try {
      const fetchImsis = async (metric: string): Promise<string[]> => {
        const url = new URL('/api/v1/label/imsi/values', prometheusUrl);
        url.searchParams.set('match[]', metric);
        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
        const body: any = await response.json();
        return Array.isArray(body?.data) ? body.data : [];
      };

      const [imsis4g5g, imsis2g] = await Promise.all([
        fetchImsis('open5gs_subscriber_up_bytes_total'),
        fetchImsis('open5gs_gsm2g_subscriber_up_bytes_total'),
      ]);
      const imsis = Array.from(new Set([...imsis4g5g, ...imsis2g]));

      const nicknameByImsi = await subscriberRepo.getNicknamesByImsi(imsis);
      res.json({
        subscribers: imsis.map(imsi => ({ imsi, nickname: nicknameByImsi[imsi] })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list subscribers with traffic history');
      res.status(500).json({ error: msg });
    }
  });

  // ── GET /radios — radios currently seen in traffic data, for the filter
  // dropdown. Bounded to the last 24h (unlike /subscribers above) so a
  // decommissioned/renamed radio doesn't linger for the full 30-day
  // retention window.
  router.get('/radios', async (_req: Request, res: Response) => {
    try {
      const endSec = Math.floor(Date.now() / 1000);
      const startSec = endSec - 24 * 3600;
      const url = new URL('/api/v1/label/radio_name/values', prometheusUrl);
      url.searchParams.set('match[]', 'open5gs_radio_info');
      url.searchParams.set('start', String(startSec));
      url.searchParams.set('end', String(endSec));
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      const body: any = await response.json();
      const radios: string[] = Array.isArray(body?.data) ? body.data.filter(Boolean) : [];
      res.json({ radios });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list radios with traffic history');
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
