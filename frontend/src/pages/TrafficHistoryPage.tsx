import { useState, useEffect, useCallback, useMemo } from 'react';
import { TrendingUp, RefreshCw, Gauge, RotateCcw, ArrowUp, ArrowDown, Wallet, Database, Phone, LayoutGrid, PanelLeft, Info } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, BarChart, Bar,
} from 'recharts';
import { trafficHistoryApi, chargingPlansApi, type TrafficHistorySubscriber, type SubscriberUsage } from '../api';
import { TimeRangePicker, type TimeRangeValue } from '../components/common/TimeRangePicker';
import { SpeedTestServerModal } from '../components/trafficHistory/SpeedTestServerModal';
import { useZoomableChartData, type ZoomableChartData } from '../hooks/useZoomableChartData';
import { FEATURES } from '../config/features';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

type Resolution = '5m' | '15m' | '1h';
type RanType = '' | '2g' | '4g' | '5g';

const DEFAULT_TIME_RANGE: TimeRangeValue = { type: 'relative', ms: 24 * 60 * 60 * 1000, label: 'Last 24 hours' };

// Resolution auto-suggested by range width — still overridable below.
function suggestResolution(rangeMs: number): Resolution {
  if (rangeMs <= 6 * 60 * 60 * 1000) return '5m';
  if (rangeMs <= 3 * 24 * 60 * 60 * 1000) return '15m';
  return '1h';
}

interface ChartPoint {
  ts: number;
  label: string;
  upMbps: number;
  downMbps: number;
}

// Up and Down used to share one chart with two overlaid Areas — split so
// each direction gets its own full-height scale (a busy upload burst no
// longer visually flattens a much smaller download trace, or vice versa).
// Both charts share one `zoom` instance (lifted to the parent) so dragging
// on either one zooms both together, matching Grafana's linked-panel feel.
function DirectionChart({ dataKey, name, color, gradientId, zoom, height = 240 }: {
  dataKey: 'upMbps' | 'downMbps'; name: string; color: string; gradientId: string;
  zoom: ZoomableChartData<ChartPoint>; height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={zoom.displayData}
        margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
        onMouseDown={zoom.onMouseDown}
        onMouseMove={zoom.onMouseMove}
        onMouseUp={zoom.onMouseUp}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.4} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} minTickGap={40} allowDataOverflow />
        <YAxis
          tick={{ fontSize: 11, fill: '#94a3b8' }} allowDataOverflow
          label={{ value: 'Mbps', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
        />
        <Tooltip contentStyle={{ background: '#1a2236', border: '1px solid #1e293b', fontSize: 12 }} labelStyle={{ color: '#e2e8f0' }} />
        <Area type="monotone" dataKey={dataKey} name={name} stroke={color} fill={`url(#${gradientId})`} strokeWidth={2} isAnimationActive={false} />
        {/* Deliberately NOT `color` (this series' own fill) — a same-hue
            translucent box on top of an already similarly-colored gradient
            has almost no contrast and is easy to miss mid-drag. A neutral
            light tone shows up clearly against any series color. */}
        {zoom.selection && (
          <ReferenceArea x1={zoom.selection.x1} x2={zoom.selection.x2} stroke="#e2e8f0" strokeOpacity={0.8} strokeWidth={1} fill="#e2e8f0" fillOpacity={0.25} />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface UeUsageRow extends SubscriberUsage {
  imsi: string;
  nickname?: string;
  planName: string;
}

function formatUsageBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function formatUsageMinutes(seconds: number): string {
  return `${Math.floor(seconds / 60)} min`;
}

// The default "Unlimited" plan (backend: ensureDefaultUnlimitedPlan() in
// charging-plans-controller.ts) stores a very large finite cap rather than a
// dedicated no-cap sentinel — see that function's own comment. 100,000
// GB/min is a round number no operator would type by hand for a real cap,
// so it doubles as the "just show Unlimited" display threshold here too —
// only applied to TOTAL/cap values, never to a used amount.
function formatCapBytes(bytes: number): string {
  return bytes / 1_000_000_000 >= 100_000 ? 'Unlimited' : formatUsageBytes(bytes);
}
function formatCapMinutes(seconds: number): string {
  return seconds / 60 >= 100_000 ? 'Unlimited' : formatUsageMinutes(seconds);
}

// Green under 70%, amber 70-90%, red above — same "getting close to the cap"
// visual language a data plan's own carrier app would use.
function usageBarColor(used: number, total: number, baseColor: string): string {
  if (total <= 0) return baseColor;
  const pct = (used / total) * 100;
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return baseColor;
}

function UsageBar({ used, total, color }: { used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="w-full h-1.5 bg-nms-surface-2 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: usageBarColor(used, total, color) }}
      />
    </div>
  );
}

function UePlanUsageCard({ row }: { row: UeUsageRow }) {
  return (
    <div className="p-3 rounded-lg border border-nms-border bg-nms-surface-2/30">
      <div className="flex items-center justify-between mb-2.5 gap-2">
        <span className="text-xs font-mono text-nms-text truncate" title={row.imsi}>{row.nickname || row.imsi}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-nms-accent/10 text-nms-accent shrink-0">{row.planName}</span>
      </div>
      <div className="space-y-2.5">
        <div>
          <div className="flex items-center justify-between text-[11px] text-nms-text-dim mb-1">
            <span className="flex items-center gap-1"><Database className="w-3 h-3" /> Data</span>
            <span className="font-mono">{formatUsageBytes(row.dataUsedBytes)} / {formatCapBytes(row.dataTotalBytes)}</span>
          </div>
          <UsageBar used={row.dataUsedBytes} total={row.dataTotalBytes} color="#38bdf8" />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] text-nms-text-dim mb-1">
            <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> Airtime</span>
            <span className="font-mono">{formatUsageMinutes(row.voiceUsedSeconds)} / {formatCapMinutes(row.voiceTotalSeconds)}</span>
          </div>
          <UsageBar used={row.voiceUsedSeconds} total={row.voiceTotalSeconds} color="#10b981" />
        </div>
      </div>
    </div>
  );
}

type SummaryPeriod = 'day' | 'week' | 'month';

const PERIOD_COUNT: Record<SummaryPeriod, number> = { day: 14, week: 8, month: 6 };
const PERIOD_LABEL: Record<SummaryPeriod, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly' };

interface PeriodBarPoint {
  label: string;
  gb: number;
}

// Rich single-UE view — the dropdown-driven alternative to the card grid.
// Data-over-time is real (Prometheus increase() queries, same counters the
// chart at the top of this page already reads). Airtime-over-time is
// deliberately NOT shown as a chart here: SigScale OCS's own accounting log
// (ocs_log's acct disk_log, queryable via ocs_log:acct_query/5) is confirmed
// live (2026-09-17) to be completely empty despite real, confirmed Gy and Ro
// billing activity — the rating engine debits buckets directly and never
// calls ocs_log:acct_log itself, so nothing is actually being logged for
// history in this deployment yet. Rather than fake a chart with only the
// current snapshot repeated, or silently omit it, this says so explicitly —
// getting real historical CDRs working is a separate follow-up (see memory
// sigscale_ocs_module_progress).
function UeUsageDetail({ row }: { row: UeUsageRow | null }) {
  const [period, setPeriod] = useState<SummaryPeriod>('day');
  const [barPoints, setBarPoints] = useState<PeriodBarPoint[]>([]);
  const [barLoading, setBarLoading] = useState(false);

  useEffect(() => {
    if (!row) { setBarPoints([]); return; }
    setBarLoading(true);
    trafficHistoryApi.periodSummary({ imsi: row.imsi, period, count: PERIOD_COUNT[period] })
      .then(r => {
        setBarPoints(r.points.map(p => ({
          label: new Date(p.periodStart).toLocaleDateString(undefined,
            period === 'month' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' }),
          gb: Number((p.bytes / 1_000_000_000).toFixed(3)),
        })));
      })
      .catch(() => setBarPoints([]))
      .finally(() => setBarLoading(false));
  }, [row, period]);

  if (!row) {
    return <div className="p-12 text-center text-nms-text-dim text-sm">Select a UE above to see its usage detail.</div>;
  }

  const avgGbPerPeriod = barPoints.length > 0
    ? barPoints.reduce((sum, p) => sum + p.gb, 0) / barPoints.length
    : 0;

  return (
    <div className="space-y-5">
      {/* Current snapshot — bigger than the card-grid version */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="p-4 rounded-lg border border-nms-border bg-nms-surface-2/30">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5" /> Data
            </span>
            <span className="text-xs text-nms-text-dim">
              {row.dataTotalBytes > 0 && row.dataTotalBytes / 1_000_000_000 < 100_000
                ? `${((row.dataUsedBytes / row.dataTotalBytes) * 100).toFixed(0)}% used` : ''}
            </span>
          </div>
          <p className="text-2xl font-display font-semibold text-nms-text">
            {formatUsageBytes(row.dataUsedBytes)}
            <span className="text-sm text-nms-text-dim font-normal"> / {formatCapBytes(row.dataTotalBytes)}</span>
          </p>
          <div className="mt-2"><UsageBar used={row.dataUsedBytes} total={row.dataTotalBytes} color="#38bdf8" /></div>
        </div>
        <div className="p-4 rounded-lg border border-nms-border bg-nms-surface-2/30">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5" /> Airtime
            </span>
            <span className="text-xs text-nms-text-dim">
              {row.voiceTotalSeconds > 0 && row.voiceTotalSeconds / 60 < 100_000
                ? `${((row.voiceUsedSeconds / row.voiceTotalSeconds) * 100).toFixed(0)}% used` : ''}
            </span>
          </div>
          <p className="text-2xl font-display font-semibold text-nms-text">
            {formatUsageMinutes(row.voiceUsedSeconds)}
            <span className="text-sm text-nms-text-dim font-normal"> / {formatCapMinutes(row.voiceTotalSeconds)}</span>
          </p>
          <div className="mt-2"><UsageBar used={row.voiceUsedSeconds} total={row.voiceTotalSeconds} color="#10b981" /></div>
        </div>
      </div>

      {/* Data usage over time — real Prometheus data */}
      <div>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Data Usage Over Time</p>
          <div className="flex gap-1 p-0.5 bg-nms-surface-2 rounded-md border border-nms-border">
            {(['day', 'week', 'month'] as SummaryPeriod[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={clsx(
                  'px-2.5 py-1 rounded text-[11px] font-medium transition-all capitalize',
                  period === p ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        {barLoading ? (
          <div className="p-8 text-center text-nms-text-dim text-sm">Loading…</div>
        ) : barPoints.length === 0 ? (
          <div className="p-8 text-center text-nms-text-dim text-sm">No data recorded for this subscriber yet.</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={barPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} label={{ value: 'GB', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: '#1a2236', border: '1px solid #1e293b', fontSize: 12 }}
                  labelStyle={{ color: '#e2e8f0' }}
                  formatter={(v: number) => [`${v.toFixed(2)} GB`, PERIOD_LABEL[period]]}
                />
                <Bar dataKey="gb" fill="#38bdf8" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <p className="text-xs text-nms-text-dim mt-2">
              Average {avgGbPerPeriod.toFixed(2)} GB per {period}. Limited by Prometheus's own retention window (30 days) — older periods show as zero, not missing.
            </p>
          </>
        )}
      </div>

      {/* Airtime over time — honest gap, not a fake chart */}
      <div className="flex items-start gap-2 p-3 rounded-lg border border-dashed border-nms-border text-xs text-nms-text-dim">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          Airtime usage over time isn't available yet — SigScale OCS debits voice buckets directly without writing
          to its own historical accounting log in this deployment, so there's no per-day/week/month breakdown to show,
          only the current snapshot above.
        </span>
      </div>
    </div>
  );
}

export function TrafficHistoryPage() {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(DEFAULT_TIME_RANGE);
  const [resolution, setResolution] = useState<Resolution>('5m');
  const [resolutionOverridden, setResolutionOverridden] = useState(false);
  const [imsi, setImsi] = useState<string>('');
  const [subscribers, setSubscribers] = useState<TrafficHistorySubscriber[]>([]);
  const [radio, setRadio] = useState<string>('');
  const [radios, setRadios] = useState<string[]>([]);
  const [ranType, setRanType] = useState<RanType>('');
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [speedTestModalOpen, setSpeedTestModalOpen] = useState(false);
  const [ueUsage, setUeUsage] = useState<UeUsageRow[]>([]);
  const [ueUsageLoading, setUeUsageLoading] = useState(true);
  const [ueUsageLayout, setUeUsageLayout] = useState<'cards' | 'detail'>('cards');
  const [detailImsi, setDetailImsi] = useState<string>('');

  // Resolves the current selection to a concrete {from, to} — relative ranges
  // are re-anchored to "now" every time this runs, absolute ranges are fixed.
  const resolveRange = useCallback((): { from: Date; to: Date; ms: number } => {
    if (timeRange.type === 'absolute') {
      return { from: timeRange.from, to: timeRange.to, ms: timeRange.to.getTime() - timeRange.from.getTime() };
    }
    const to = new Date();
    const from = new Date(to.getTime() - timeRange.ms);
    return { from, to, ms: timeRange.ms };
  }, [timeRange]);

  useEffect(() => {
    if (!resolutionOverridden) setResolution(suggestResolution(resolveRange().ms));
  }, [timeRange, resolutionOverridden, resolveRange]);

  useEffect(() => {
    trafficHistoryApi.listSubscribersWithHistory()
      .then(r => setSubscribers(r.subscribers))
      .catch(() => {});
    trafficHistoryApi.listRadiosWithHistory()
      .then(r => setRadios(r.radios))
      .catch(() => {});
  }, []);

  // Data + airtime per UE — sourced from Charging Plans/OCS, not Prometheus:
  // this is the only system in this project that tracks voice/airtime usage
  // at all, so a subscriber not assigned to any plan simply has nothing to
  // show here (data-only traffic for them still shows via the aggregate/
  // per-subscriber chart above). One usage call per plan, matching this
  // project's own established "bulk GET, match client-side" convention.
  const loadUeUsage = useCallback(async () => {
    if (!FEATURES.ocs) { setUeUsageLoading(false); return; }
    setUeUsageLoading(true);
    try {
      const plans = await chargingPlansApi.list();
      const rows: UeUsageRow[] = [];
      for (const plan of plans) {
        if (plan.imsis.length === 0) continue;
        const usage = await chargingPlansApi.usage(plan._id);
        for (const planImsi of plan.imsis) {
          const u = usage[planImsi];
          if (!u) continue;
          rows.push({
            imsi: planImsi,
            nickname: subscribers.find(s => s.imsi === planImsi)?.nickname,
            planName: plan.name,
            ...u,
          });
        }
      }
      setUeUsage(rows);
    } catch {
      // Non-fatal — this section supplements the page, doesn't gate it.
    } finally {
      setUeUsageLoading(false);
    }
  }, [subscribers]);

  // Polled every 30s (not just on mount) — this card surfaces real billing
  // state (SigScale OCS voice/data buckets), and unlike the traffic chart
  // above it wasn't wired to the page's own "Refresh" button at all until
  // this fix, so a subscriber's usage could sit stale indefinitely with no
  // way to see it update short of a full page reload. Found live 2026-09-17:
  // a real debited call didn't appear here because NOTHING ever re-fetched
  // this section after initial page load.
  useEffect(() => {
    loadUeUsage();
    const interval = setInterval(loadUeUsage, 30_000);
    return () => clearInterval(interval);
  }, [loadUeUsage]);

  // A radio or 4G/5G RAN-type filter narrows the subscriber scope even
  // without a specific IMSI chosen (matching the backend's own
  // radio/generation-narrowing logic) — only a plain "All" with no radio and
  // no generation stays a true network-wide aggregate. generation=2g always
  // implies subscriber scope too, since the 2G aggregate metric family has
  // its own separate scope=aggregate path the UI doesn't expose yet.
  const effectiveScope = imsi || radio || ranType ? 'subscriber' : 'aggregate';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to, ms } = resolveRange();
      const { points: raw } = await trafficHistoryApi.query({
        scope: effectiveScope,
        resolution,
        imsi: imsi || undefined,
        radio: radio || undefined,
        generation: ranType || undefined,
        from: from.toISOString(),
        to: to.toISOString(),
      });

      // Aggregate scope can return one document per DNN at the same
      // timestamp (e.g. "internet" + "ims") — sum them into a single series.
      const byTs = new Map<number, { upMbps: number; downMbps: number }>();
      for (const p of raw) {
        const ts = new Date(p.ts).getTime();
        const acc = byTs.get(ts) ?? { upMbps: 0, downMbps: 0 };
        acc.upMbps += p.upMbps;
        acc.downMbps += p.downMbps;
        byTs.set(ts, acc);
      }

      // >= 24h, not the "wider than ~1.5 days" it used to be: at exactly 24h
      // (the default range), a date-less "HH:MM" label makes the very first
      // point (~24h ago) and the very last point (now) collide on the same
      // wall-clock minute. Recharts' drag-to-zoom matches the ReferenceArea
      // against these label strings, so dragging across the chart — the
      // obvious way to try the feature — landed both ends on identical
      // labels and the selection box couldn't render at all. Any window
      // that can wrap a full day needs the date to keep every label unique.
      const showDate = ms >= 24 * 60 * 60 * 1000;
      const merged: ChartPoint[] = Array.from(byTs.entries())
        .sort(([a], [b]) => a - b)
        .map(([ts, v]) => ({
          ts,
          label: new Date(ts).toLocaleString(undefined, showDate
            ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { hour: '2-digit', minute: '2-digit' }),
          upMbps: Number(v.upMbps.toFixed(3)),
          downMbps: Number(v.downMbps.toFixed(3)),
        }));

      setPoints(merged);
    } catch {
      toast.error('Failed to load traffic history');
    } finally {
      setLoading(false);
    }
  }, [resolveRange, resolution, imsi, radio, ranType, effectiveScope]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    return { upMbps: last.upMbps, downMbps: last.downMbps };
  }, [points]);

  const zoom = useZoomableChartData(points);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display text-nms-text flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-nms-accent" />
            Traffic History
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Throughput over time — aggregate per-DNN, or filtered by subscriber, radio, or RAN type.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          <button onClick={() => { load(); loadUeUsage(); }} className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5" title="Refresh">
            <RefreshCw className={clsx('w-3 h-3', loading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setSpeedTestModalOpen(true)}
            className="nms-btn-ghost text-xs flex items-center gap-1.5 px-2.5 py-1.5"
            title="Speed Test Server"
          >
            <Gauge className="w-3 h-3" />
            Speed Test Server
          </button>
        </div>
      </div>

      {speedTestModalOpen && <SpeedTestServerModal onClose={() => setSpeedTestModalOpen(false)} />}

      {/* Filters */}
      <div className="nms-card flex flex-wrap items-end gap-4">
        <div>
          <label className="nms-label">Resolution</label>
          <select
            className="nms-input"
            value={resolution}
            onChange={e => { setResolution(e.target.value as Resolution); setResolutionOverridden(true); }}
          >
            <option value="5m">5 minutes</option>
            <option value="15m">15 minutes</option>
            <option value="1h">1 hour</option>
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label className="nms-label">Subscriber</label>
          <select className="nms-input" value={imsi} onChange={e => setImsi(e.target.value)}>
            <option value="">All (aggregate)</option>
            {subscribers.map(s => (
              <option key={s.imsi} value={s.imsi}>
                {s.nickname ? `${s.nickname} (${s.imsi})` : s.imsi}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="nms-label">Radio</label>
          <select className="nms-input" value={radio} onChange={e => setRadio(e.target.value)}>
            <option value="">All radios</option>
            {radios.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div>
          <label className="nms-label">RAN Type</label>
          <select className="nms-input" value={ranType} onChange={e => setRanType(e.target.value as RanType)}>
            <option value="">All</option>
            <option value="2g">2G</option>
            <option value="4g">4G</option>
            <option value="5g">5G</option>
          </select>
        </div>

        {totals && (
          <div className="flex gap-4 text-sm">
            <div>
              <span className="text-nms-text-dim">Latest Up: </span>
              <span className="font-mono text-nms-accent">{totals.upMbps.toFixed(2)} Mbps</span>
            </div>
            <div>
              <span className="text-nms-text-dim">Latest Down: </span>
              <span className="font-mono text-nms-green">{totals.downMbps.toFixed(2)} Mbps</span>
            </div>
          </div>
        )}
      </div>

      {/* Charts — Up and Down split into their own scales, zoom shared across both */}
      <div className="nms-card">
        {loading ? (
          <div className="p-12 text-center text-nms-text-dim">Loading traffic history...</div>
        ) : points.length === 0 ? (
          <div className="p-12 text-center text-nms-text-dim">
            No data yet for this range{effectiveScope === 'subscriber' ? ' / filter' : ''}. Data accumulates as Prometheus scrapes the backend's metrics endpoint.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-nms-text-dim">Drag across either chart to zoom into a time range.</p>
              {zoom.isZoomed && (
                <button onClick={zoom.resetZoom} className="nms-btn-ghost flex items-center gap-1.5 text-xs px-2 py-1">
                  <RotateCcw className="w-3.5 h-3.5" /> Reset Zoom
                </button>
              )}
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <ArrowUp className="w-3 h-3 text-[#38bdf8]" /> Upload
                </p>
                <DirectionChart dataKey="upMbps" name="Up" color="#38bdf8" gradientId="upGradient" zoom={zoom} />
              </div>
              <div>
                <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <ArrowDown className="w-3 h-3 text-[#10b981]" /> Download
                </p>
                <DirectionChart dataKey="downMbps" name="Down" color="#10b981" gradientId="downGradient" zoom={zoom} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Data + airtime usage per UE — from Charging Plans/OCS, a separate
          data source from the GTP U-Plane chart above (that one has no
          concept of voice/airtime at all). */}
      {FEATURES.ocs && (
        <div className="nms-card">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-sm font-semibold font-display flex items-center gap-2">
              <Wallet className="w-4 h-4 text-nms-accent" /> Data &amp; Airtime Usage per UE
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-nms-text-dim">From Charging Plans (SigScale OCS)</span>
              <div className="flex gap-1 p-0.5 bg-nms-surface-2 rounded-md border border-nms-border">
                <button
                  onClick={() => setUeUsageLayout('cards')}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all',
                    ueUsageLayout === 'cards' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text',
                  )}
                >
                  <LayoutGrid className="w-3.5 h-3.5" /> Cards
                </button>
                <button
                  onClick={() => setUeUsageLayout('detail')}
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all',
                    ueUsageLayout === 'detail' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text',
                  )}
                >
                  <PanelLeft className="w-3.5 h-3.5" /> Detail
                </button>
              </div>
            </div>
          </div>

          {ueUsageLoading ? (
            <div className="p-8 text-center text-nms-text-dim text-sm">Loading usage…</div>
          ) : ueUsage.length === 0 ? (
            <div className="p-8 text-center text-nms-text-dim text-sm">
              No subscribers on a charging plan yet — assign one from the Subscribers page or the Charging Plans page.
            </div>
          ) : ueUsageLayout === 'cards' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {ueUsage.map(row => <UePlanUsageCard key={row.imsi} row={row} />)}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="max-w-sm">
                <label className="nms-label">Select UE</label>
                <select className="nms-input" value={detailImsi} onChange={e => setDetailImsi(e.target.value)}>
                  <option value="">Choose a subscriber…</option>
                  {ueUsage.map(row => (
                    <option key={row.imsi} value={row.imsi}>{row.nickname ? `${row.nickname} (${row.imsi})` : row.imsi}</option>
                  ))}
                </select>
              </div>
              <UeUsageDetail row={ueUsage.find(r => r.imsi === detailImsi) ?? null} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
