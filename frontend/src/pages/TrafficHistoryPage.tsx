import { useState, useEffect, useCallback, useMemo } from 'react';
import { TrendingUp, RefreshCw } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { trafficHistoryApi, type TrafficHistorySubscriber } from '../api';
import { TimeRangePicker, type TimeRangeValue } from '../components/common/TimeRangePicker';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';

type Resolution = '5m' | '15m' | '1h';

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

export function TrafficHistoryPage() {
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(DEFAULT_TIME_RANGE);
  const [resolution, setResolution] = useState<Resolution>('5m');
  const [resolutionOverridden, setResolutionOverridden] = useState(false);
  const [imsi, setImsi] = useState<string>('');
  const [subscribers, setSubscribers] = useState<TrafficHistorySubscriber[]>([]);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(true);

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
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to, ms } = resolveRange();
      const { points: raw } = await trafficHistoryApi.query({
        scope: imsi ? 'subscriber' : 'aggregate',
        resolution,
        imsi: imsi || undefined,
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

      const showDate = ms > 36 * 60 * 60 * 1000; // wider than ~1.5 days — dates start being useful
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
  }, [resolveRange, resolution, imsi]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    return { upMbps: last.upMbps, downMbps: last.downMbps };
  }, [points]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-display text-nms-text flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-nms-accent" />
            Traffic History
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            GTP U-Plane throughput over time — aggregate per-DNN or filtered to a single subscriber.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <TimeRangePicker value={timeRange} onChange={setTimeRange} />
          <button onClick={load} className="nms-btn-ghost flex items-center gap-2" title="Refresh">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

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

      {/* Chart */}
      <div className="nms-card">
        {loading ? (
          <div className="p-12 text-center text-nms-text-dim">Loading traffic history...</div>
        ) : points.length === 0 ? (
          <div className="p-12 text-center text-nms-text-dim">
            No data yet for this range{imsi ? ' / subscriber' : ''}. Data accumulates as Prometheus scrapes the backend's metrics endpoint.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <AreaChart data={points} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="upGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="downGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} minTickGap={40} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} label={{ value: 'Mbps', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#1a2236', border: '1px solid #1e293b', fontSize: 12 }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="upMbps" name="Up" stroke="#38bdf8" fill="url(#upGradient)" strokeWidth={2} />
              <Area type="monotone" dataKey="downMbps" name="Down" stroke="#10b981" fill="url(#downGradient)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
