import { useState, useEffect, useCallback } from 'react';
import { RotateCw, Signal, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { gsmApi, type GsmSignalSample } from '../api/gsm';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// 3GPP TS 05.08 thresholds — GSM RxLev/RxQual, NOT the 4G page's RSRP/SINR scale.
function rxLevTone(dbm: number | null): 'good' | 'warn' | 'bad' | 'neutral' {
  if (dbm === null) return 'neutral';
  if (dbm >= -80) return 'good';
  if (dbm >= -95) return 'warn';
  return 'bad';
}
function rxQualTone(q: number | null): 'good' | 'warn' | 'bad' | 'neutral' {
  if (q === null) return 'neutral';
  if (q <= 2) return 'good';
  if (q <= 4) return 'warn';
  return 'bad';
}
const TONE_CLASS: Record<string, string> = {
  good: 'text-green-400', warn: 'text-amber-400', bad: 'text-red-400', neutral: 'text-nms-text-dim',
};

function MetricTile({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <div className="bg-nms-bg rounded-lg border border-nms-border px-3 py-2">
      <p className="text-[10px] text-nms-text-dim uppercase tracking-wider">{label}</p>
      <p className={clsx('text-sm font-mono font-semibold', TONE_CLASS[tone])}>{value}</p>
    </div>
  );
}

export function Gsm2gSignalPage() {
  const [samples, setSamples] = useState<GsmSignalSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImsi, setSelectedImsi] = useState<string | null>(null);
  const [history, setHistory] = useState<GsmSignalSample[]>([]);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    gsmApi.getSignalOverview().then(r => setSamples(r.samples)).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!selectedImsi) { setHistory([]); return; }
    gsmApi.getSignalHistory(selectedImsi).then(r => setHistory(r.samples)).catch(() => setHistory([]));
    const t = setInterval(() => gsmApi.getSignalHistory(selectedImsi).then(r => setHistory(r.samples)).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [selectedImsi]);

  const filtered = samples.filter(s =>
    !search || s.imsi.includes(search) || (s.nickname ?? '').toLowerCase().includes(search.toLowerCase()) || (s.msisdn ?? '').includes(search),
  );
  const selected = samples.find(s => s.imsi === selectedImsi) ?? null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">2G UE Signal</h1>
          <p className="text-sm text-nms-text-dim mt-1">Per-UE 2G radio measurements from osmo-bsc's meas-feed (RxLev / RxQual / TA)</p>
        </div>
        <button onClick={load} className="nms-btn-ghost flex items-center gap-1.5 text-sm" disabled={loading}>
          <RotateCw className={clsx('w-4 h-4', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      <div className="bg-nms-surface rounded-lg border border-nms-border p-3 text-xs text-nms-text-dim">
        Real per-UE 2G measurement reports (3GPP TS 08.58), pushed directly by osmo-bsc's own <code className="font-mono">meas-feed</code> — already
        resolved to a real IMSI, no separate identity backfill needed. Only subscribers with an active or recently-active dedicated channel
        (not just idle-camped) show up here — a resting subscriber has nothing to measure yet.
      </div>

      <div className="relative max-w-xs">
        <Search className="w-3.5 h-3.5 text-nms-text-dim absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search IMSI, nickname, MSISDN…" className="nms-input pl-8 text-xs" />
      </div>

      {filtered.length === 0 ? (
        <div className="nms-card border-dashed border-nms-border text-center py-10">
          <Signal className="w-10 h-10 text-nms-text-dim/40 mx-auto mb-3" />
          <p className="text-sm text-nms-text-dim">No 2G signal samples yet.</p>
          <p className="text-xs text-nms-text-dim mt-1">Shows up once a real subscriber has an active dedicated channel.</p>
        </div>
      ) : (
        <div className="grid xl:grid-cols-[360px_1fr] gap-4">
          <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
            {filtered.map(s => (
              <button
                key={s.imsi}
                onClick={() => setSelectedImsi(s.imsi)}
                className={clsx('w-full text-left px-3 py-2 rounded-lg border transition-colors',
                  s.imsi === selectedImsi ? 'bg-nms-accent/10 border-nms-accent/40' : 'bg-nms-bg border-nms-border hover:border-nms-accent/30')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-nms-text truncate">{s.nickname || s.imsi}</span>
                  <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0',
                    rxLevTone(s.ulRxLevDbm) === 'good' ? 'bg-green-400' : rxLevTone(s.ulRxLevDbm) === 'warn' ? 'bg-amber-400' : rxLevTone(s.ulRxLevDbm) === 'bad' ? 'bg-red-400' : 'bg-nms-text-dim')} />
                </div>
                <p className="text-[11px] text-nms-text-dim font-mono">{s.imsi}</p>
                <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                  <MetricTile label="UL RxLev" value={s.ulRxLevDbm !== null ? `${s.ulRxLevDbm} dBm` : '—'} tone={rxLevTone(s.ulRxLevDbm)} />
                  <MetricTile label="UL RxQual" value={s.ulRxQual !== null ? String(s.ulRxQual) : '—'} tone={rxQualTone(s.ulRxQual)} />
                  <MetricTile label="TA" value={s.timingAdvance !== null ? String(s.timingAdvance) : '—'} tone="neutral" />
                </div>
              </button>
            ))}
          </div>

          <div className="nms-card">
            {!selected ? (
              <p className="text-sm text-nms-text-dim py-10 text-center">Select a subscriber to see its signal history.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-nms-text">{selected.nickname || selected.imsi}</h3>
                  <p className="text-xs text-nms-text-dim font-mono">{selected.imsi} {selected.msisdn ? `· ${selected.msisdn}` : ''} · last sample {selected.timestamp}</p>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <MetricTile label="UL RxLev (full)" value={selected.ulRxLevDbm !== null ? `${selected.ulRxLevDbm} dBm` : '—'} tone={rxLevTone(selected.ulRxLevDbm)} />
                  <MetricTile label="UL RxQual (full)" value={selected.ulRxQual !== null ? String(selected.ulRxQual) : '—'} tone={rxQualTone(selected.ulRxQual)} />
                  <MetricTile label="DL RxLev (full)" value={selected.dlRxLevDbm !== null ? `${selected.dlRxLevDbm} dBm` : '—'} tone={rxLevTone(selected.dlRxLevDbm)} />
                  <MetricTile label="DL RxQual (full)" value={selected.dlRxQual !== null ? String(selected.dlRxQual) : '—'} tone={rxQualTone(selected.dlRxQual)} />
                  <MetricTile label="MS Power" value={selected.msPowerDbm !== null ? `${selected.msPowerDbm} dBm` : '—'} tone="neutral" />
                  <MetricTile label="BS Power" value={selected.bsPowerDbm !== null ? `${selected.bsPowerDbm} dBm` : '—'} tone="neutral" />
                  <MetricTile label="Timing Advance" value={selected.timingAdvance !== null ? String(selected.timingAdvance) : '—'} tone="neutral" />
                  <MetricTile label="UL Path Loss" value={selected.ulPathLossDb !== null ? `${selected.ulPathLossDb} dB` : '—'} tone="neutral" />
                </div>
                {history.length > 1 && (
                  <div className="h-56">
                    <p className="text-xs font-medium text-nms-text-dim mb-2">Signal history (uplink RxLev/RxQual)</p>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={history}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--nms-border, #2a2a2a)" />
                        <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} minTickGap={40} />
                        <YAxis yAxisId="lev" domain={[-110, -40]} tick={{ fontSize: 10 }} />
                        <YAxis yAxisId="qual" orientation="right" domain={[0, 7]} tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Legend />
                        <Area yAxisId="lev" type="monotone" dataKey="ulRxLevDbm" name="UL RxLev (dBm)" stroke="#22c55e" fill="#22c55e" fillOpacity={0.15} />
                        <Area yAxisId="qual" type="monotone" dataKey="ulRxQual" name="UL RxQual" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.1} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
