import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, Antenna, CheckCircle2, ChevronRight, Gauge, Plus, Radar, RadioTower, RefreshCw, Search, Send, Settings2, Signal, Trash2, Users, Wifi } from 'lucide-react';
import toast from 'react-hot-toast';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { radioSignalApi, type SignalRadio, type SignalUe } from '../api/radioSignal';

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const tones: Record<Tone, string> = {
  good: 'text-nms-green border-nms-green/25 bg-nms-green/10',
  warn: 'text-nms-amber border-nms-amber/25 bg-nms-amber/10',
  bad: 'text-nms-red border-nms-red/25 bg-nms-red/10',
  neutral: 'text-nms-text-dim border-nms-border bg-nms-surface-2/50',
};

function quality(metric: 'rsrp' | 'rsrq' | 'rssi' | 'sinr' | 'bler', value?: number | null): Tone {
  if (value == null) return 'neutral';
  if (metric === 'rsrp') return value >= -90 ? 'good' : value >= -105 ? 'warn' : 'bad';
  if (metric === 'rsrq') return value >= -10 ? 'good' : value >= -15 ? 'warn' : 'bad';
  if (metric === 'rssi') return value >= -65 ? 'good' : value >= -80 ? 'warn' : 'bad';
  if (metric === 'sinr') return value >= 20 ? 'good' : value >= 10 ? 'warn' : 'bad';
  return value <= 5 ? 'good' : value <= 10 ? 'warn' : 'bad';
}

const fmt = (value?: number | null, unit = 'dB') => value == null ? '—' : `${Number(value).toFixed(value % 1 ? 1 : 0)} ${unit}`;
const watts = (dbm?: number | null) => dbm == null ? null : Math.pow(10, (dbm - 30) / 10);
const fmtWatts = (dbm?: number | null) => {
  const value = watts(dbm);
  if (value == null) return null;
  if (value >= 1) return `${value.toFixed(4)} W`;
  if (value >= 0.001) return `${value.toFixed(6)} W`;
  return `${value.toExponential(3)} W`;
};

function Metric({ label, value, unit, metric, showWatts = false }: { label: string; value?: number | null; unit?: string; metric: 'rsrp' | 'rsrq' | 'rssi' | 'sinr' | 'bler'; showWatts?: boolean }) {
  const tone = quality(metric, value);
  return <div className={`rounded-xl border px-3 py-2.5 ${tones[tone]}`}>
    <div className="text-[10px] uppercase tracking-[0.16em] opacity-70">{label}</div>
    <div className="mt-1 text-lg font-semibold font-display">{fmt(value, unit ?? (metric === 'bler' ? '%' : 'dB'))}</div>
    {showWatts && value != null && <div className="mt-0.5 text-[9px] font-mono opacity-60">{fmtWatts(value)}</div>}
  </div>;
}

function UeCard({ ue, selected, onClick, onWake }: { ue: SignalUe; selected: boolean; onClick: () => void; onWake: () => void }) {
  const primary = ue.sinr ?? ue.snr;
  const tone = quality('sinr', primary);
  return <button onClick={onClick} className={`w-full text-left rounded-2xl border p-4 transition-all ${selected ? 'border-nms-accent bg-nms-accent/5 shadow-[0_0_28px_rgba(6,182,212,.08)]' : 'border-nms-border bg-nms-surface hover:border-nms-accent/40'}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${tone === 'good' ? 'bg-nms-green shadow-[0_0_9px_rgba(16,185,129,.7)]' : tone === 'warn' ? 'bg-nms-amber' : tone === 'bad' ? 'bg-nms-red' : 'bg-nms-text-dim'}`} />
          <span className="font-display font-semibold text-nms-text truncate">{ue.nickname || `UE ${ue.ueId}`}</span>
        </div>
        <div className="mt-1 text-xs text-nms-text-dim font-mono truncate">IMSI {ue.imsi || 'not correlated'}</div>
      </div>
      <ChevronRight className={`w-4 h-4 shrink-0 ${selected ? 'text-nms-accent' : 'text-nms-text-dim'}`} />
    </div>
    <div className="grid grid-cols-3 gap-2 mt-4">
      <Metric label="RSRP" value={ue.rsrp} metric="rsrp" unit="dBm" showWatts />
      <Metric label="SINR" value={primary} metric="sinr" />
      <Metric label="BLER" value={ue.bler} metric="bler" />
    </div>
    <div className="mt-3 flex items-center justify-between text-[11px] text-nms-text-dim">
      <span>{ue.radioName} · {ue.vendor}</span>
      <span className="flex items-center gap-2"><span>{new Date(ue.sampledAt).toLocaleTimeString()}</span><span onClick={e => { e.stopPropagation(); onWake(); }} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-nms-accent hover:bg-nms-accent/10"><Send className="w-3 h-3" /> Wake</span></span>
    </div>
  </button>;
}

const emptyRadio: Partial<SignalRadio> = {
  name: '', vendor: 'baicells', baseUrl: 'https://', username: 'admin',
  password: '', metricsPath: '/api/ue/signals', enabled: true, allowSelfSigned: true,
};

export function RadioSignalPage(): JSX.Element {
  const [ues, setUes] = useState<SignalUe[]>([]);
  const [radios, setRadios] = useState<SignalRadio[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [search, setSearch] = useState('');
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [form, setForm] = useState<Partial<SignalRadio>>(emptyRadio);

  const load = async () => {
    try {
      const data = await radioSignalApi.overview(search, hours);
      setUes(data.ues); setRadios(data.radios);
      if (!selectedKey && data.ues[0]) setSelectedKey(`${data.ues[0].radioId}:${data.ues[0].ueId}`);
    } catch { toast.error('Unable to load radio measurements'); }
    finally { setLoading(false); }
  };
  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer); }, [search, hours]);
  useEffect(() => { const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [search, hours]);

  const selected = ues.find(ue => `${ue.radioId}:${ue.ueId}` === selectedKey) ?? ues[0];
  const summary = useMemo(() => ({
    good: ues.filter(u => quality('sinr', u.sinr ?? u.snr) === 'good').length,
    degraded: ues.filter(u => ['warn', 'bad'].includes(quality('sinr', u.sinr ?? u.snr))).length,
    avgSinr: ues.length ? ues.reduce((sum, u) => sum + (u.sinr ?? u.snr ?? 0), 0) / ues.filter(u => u.sinr != null || u.snr != null).length : null,
  }), [ues]);

  const poll = async () => {
    setPolling(true);
    try {
      const result = await radioSignalApi.poll();
      const ok = result.results.filter(r => r.success).length;
      const failed = result.results.length - ok;
      failed ? toast.error(`${failed} radio(s) unreachable`) : toast.success(`${ok} radio(s) refreshed`);
      await load();
    } catch { toast.error('Refresh failed'); }
    finally { setPolling(false); }
  };

  const saveRadio = async () => {
    try { await radioSignalApi.saveRadio(form); toast.success('Radio saved'); setConfigOpen(false); setForm(emptyRadio); await load(); }
    catch (e: any) { toast.error(e.response?.data?.error || 'Invalid configuration'); }
  };

  const discover = async () => {
    try {
      const result = await radioSignalApi.discover();
      const added = result.discovered.filter(r => r.added).length;
      toast.success(`${result.discovered.length} eNodeB(s) detected, ${added} added`);
      await load(); setConfigOpen(true);
    } catch { toast.error('Unable to read S1-MME associations'); }
  };

  const wake = async (ue: SignalUe) => {
    try {
      const result = await radioSignalApi.wake(ue.radioId, ue.imsi);
      toast.success(`${result.packets} downlink wake packets queued for ${result.targets} UE(s)`);
      setTimeout(async () => { await radioSignalApi.poll(); await load(); }, 1800);
    } catch (e: any) {
      toast.error(e.response?.data?.error || 'Unable to send a wake packet');
    }
  };

  const chart = (selected?.history ?? []).map(point => ({ ...point, time: new Date(point.sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));

  return <div className="min-h-full bg-nms-bg p-6 lg:p-8">
    <div className="max-w-[1680px] mx-auto">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-5">
        <div>
          <div className="flex items-center gap-2 text-nms-accent text-xs uppercase tracking-[0.22em]"><Antenna className="w-4 h-4" /> Radio intelligence</div>
          <h1 className="mt-2 text-3xl font-display font-semibold text-nms-text">UE Signal Quality</h1>
          <p className="mt-1 text-sm text-nms-text-dim">Unified IMSI · ICCID · MSISDN view across all radios and cells</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={discover} className="nms-btn-ghost flex items-center gap-2"><Radar className="w-4 h-4" /> Discover S1-MME</button>
          <button onClick={() => { setForm(emptyRadio); setConfigOpen(true); }} className="nms-btn-ghost flex items-center gap-2"><Settings2 className="w-4 h-4" /> Radios</button>
          <button onClick={poll} disabled={polling || !radios.length} className="nms-btn-primary flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${polling ? 'animate-spin' : ''}`} /> Refresh</button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-7">
        {[
          { label: 'Visible UEs', value: ues.length, icon: Users, detail: `${radios.length} configured radio(s)`, color: 'text-nms-accent' },
          { label: 'Excellent signal', value: summary.good, icon: Signal, detail: 'SINR ≥ 20 dB', color: 'text-nms-green' },
          { label: 'Needs attention', value: summary.degraded, icon: AlertCircle, detail: 'Yellow or red signal', color: summary.degraded ? 'text-nms-amber' : 'text-nms-text-dim' },
          { label: 'Average SINR', value: summary.avgSinr == null || !Number.isFinite(summary.avgSinr) ? '—' : `${summary.avgSinr.toFixed(1)} dB`, icon: Gauge, detail: 'All measured UEs', color: 'text-violet-400' },
        ].map(item => <div key={item.label} className="nms-card relative overflow-hidden">
          <div className="flex items-start justify-between"><div><div className="text-xs uppercase tracking-wider text-nms-text-dim">{item.label}</div><div className="mt-2 text-2xl font-display font-semibold text-nms-text">{item.value}</div></div><item.icon className={`w-5 h-5 ${item.color}`} /></div>
          <div className="mt-2 text-[11px] text-nms-text-dim">{item.detail}</div>
        </div>)}
      </div>

      <div className="mt-5 flex flex-col md:flex-row gap-3">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-nms-text-dim" /><input className="nms-input pl-10 h-11" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search IMSI, ICCID, MSISDN, UE ID, name or radio…" /></div>
        <select className="nms-input md:w-44 h-11" value={hours} onChange={e => setHours(Number(e.target.value))}><option value={1}>Last hour</option><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={168}>7 days</option></select>
      </div>

      {!loading && !ues.length ? <div className="mt-6 rounded-2xl border border-dashed border-nms-border bg-nms-surface/50 p-14 text-center">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-nms-accent/10 flex items-center justify-center"><RadioTower className="w-7 h-7 text-nms-accent" /></div>
        <h2 className="mt-5 text-lg font-display font-semibold text-nms-text">Connect your first radio</h2>
        <p className="mt-2 text-sm text-nms-text-dim max-w-xl mx-auto">Automatically discover eNodeBs connected to the MME, then enter the credentials for each radio. Passwords are encrypted on the server.</p>
        <div className="flex justify-center gap-2 mt-5"><button onClick={discover} className="nms-btn-primary inline-flex items-center gap-2"><Radar className="w-4 h-4" /> Discover via S1-MME</button><button onClick={() => setConfigOpen(true)} className="nms-btn-ghost inline-flex items-center gap-2"><Plus className="w-4 h-4" /> Add manually</button></div>
      </div> : <div className="grid xl:grid-cols-[420px_1fr] gap-5 mt-6">
        <div className="space-y-3 max-h-[760px] overflow-y-auto pr-1">{ues.map(ue => <UeCard key={`${ue.radioId}:${ue.ueId}`} ue={ue} selected={`${ue.radioId}:${ue.ueId}` === selectedKey} onClick={() => setSelectedKey(`${ue.radioId}:${ue.ueId}`)} onWake={() => wake(ue)} />)}</div>
        {selected && <div className="space-y-5">
          <div className="nms-card rounded-2xl p-5">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div><div className="flex items-center gap-3"><div className="w-11 h-11 rounded-xl bg-nms-accent/10 flex items-center justify-center"><Wifi className="w-5 h-5 text-nms-accent" /></div><div><h2 className="text-xl font-display font-semibold text-nms-text">{selected.nickname || `UE ${selected.ueId}`}</h2><p className="text-xs text-nms-text-dim">{selected.radioName} · {selected.vendor}</p></div></div></div>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-2 text-xs"><div><span className="text-nms-text-dim">IMSI</span><div className="font-mono text-nms-text">{selected.imsi || 'Not correlated'}</div></div><div><span className="text-nms-text-dim">ICCID</span><div className="font-mono text-nms-text">{selected.iccid || '—'}</div></div><div><span className="text-nms-text-dim">MSISDN</span><div className="font-mono text-nms-text">{selected.msisdn || '—'}</div></div></div>
            </div>
            {!selected.imsi && <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-nms-amber/25 bg-nms-amber/10 px-4 py-3"><div><div className="text-sm font-medium text-nms-amber">Radio UE visible — core identity unavailable</div><div className="text-xs text-nms-text-dim mt-0.5">The UE is still displayed from Baicells measurements. Its bearer may be idle or dormant, so IMSI, ICCID and MSISDN cannot yet be correlated.</div></div><button onClick={() => wake(selected)} className="nms-btn-ghost shrink-0 inline-flex items-center gap-2"><Send className="w-4 h-4" /> Send wake packet</button></div>}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-6"><Metric label="RSRP" value={selected.rsrp} metric="rsrp" unit="dBm" showWatts /><Metric label="RSRQ" value={selected.rsrq} metric="rsrq" /><Metric label="RSSI" value={selected.rssi} metric="rssi" unit="dBm" showWatts /><Metric label="SINR / SNR" value={selected.sinr ?? selected.snr} metric="sinr" /><Metric label="BLER" value={selected.bler} metric="bler" /></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs"><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">UE TX power</span><div className="mt-1 text-nms-text font-semibold">{fmt(selected.txPower, 'dBm')}</div>{selected.txPower != null && <div className="mt-0.5 text-[9px] font-mono text-nms-text-dim">{fmtWatts(selected.txPower)}</div>}</div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">Path loss</span><div className="mt-1 text-nms-text font-semibold">{fmt(selected.pathLoss, 'dB')}</div></div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">Primary DL CQI</span><div className="mt-1 text-nms-text font-semibold">{selected.primaryDlCqi ?? '—'}</div></div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">Secondary DL CQI</span><div className="mt-1 text-nms-text font-semibold">{selected.secondaryDlCqi ?? '—'}</div></div></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs"><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">MCS DL / UL</span><div className="mt-1 text-nms-text font-semibold">{selected.dlMcs ?? '—'} / {selected.ulMcs ?? '—'}</div></div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">DL throughput</span><div className="mt-1 text-nms-text font-semibold">{fmt(selected.dlMbps, 'Mbps')}</div></div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">UL throughput</span><div className="mt-1 text-nms-text font-semibold">{fmt(selected.ulMbps, 'Mbps')}</div></div><div className="rounded-xl bg-nms-surface-2 p-3"><span className="text-nms-text-dim">Radio UE ID</span><div className="mt-1 text-nms-text font-semibold">{selected.ueId}</div></div></div>
          </div>
          <div className="nms-card rounded-2xl p-5 h-[390px]"><div className="flex items-center justify-between mb-5"><div><h3 className="font-display font-semibold text-nms-text">Signal history</h3><p className="text-xs text-nms-text-dim mt-0.5">RSRP and SINR over the selected period</p></div><Activity className="w-5 h-5 text-nms-accent" /></div><ResponsiveContainer width="100%" height="82%"><AreaChart data={chart}><defs><linearGradient id="rsrpFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3}/><stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/></linearGradient><linearGradient id="sinrFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.25}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="time" stroke="#64748b" fontSize={11}/><YAxis yAxisId="left" stroke="#64748b" fontSize={11}/><YAxis yAxisId="right" orientation="right" stroke="#64748b" fontSize={11}/><Tooltip contentStyle={{ background:'#111827', border:'1px solid #1e293b', borderRadius:12, fontSize:12 }}/><Legend/><Area yAxisId="left" type="monotone" dataKey="rsrp" name="RSRP (dBm)" stroke="#06b6d4" fill="url(#rsrpFill)" strokeWidth={2}/><Area yAxisId="right" type="monotone" dataKey="sinr" name="SINR (dB)" stroke="#10b981" fill="url(#sinrFill)" strokeWidth={2}/></AreaChart></ResponsiveContainer></div>
        </div>}
      </div>}
    </div>

    {configOpen && <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) setConfigOpen(false); }}><div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-nms-border bg-nms-surface shadow-2xl"><div className="p-6 border-b border-nms-border flex items-center justify-between"><div><h2 className="font-display text-xl font-semibold text-nms-text">Radio sources</h2><p className="text-xs text-nms-text-dim mt-1">Multi-vendor connectors — shared Baicells profile</p></div><button className="nms-btn-ghost" onClick={() => setConfigOpen(false)}>Close</button></div>
      {!!radios.length && <div className="p-5 border-b border-nms-border space-y-2">{radios.map(r => <div key={r.id} className="flex items-center gap-3 rounded-xl bg-nms-surface-2 p-3"><RadioTower className="w-4 h-4 text-nms-accent"/><button className="flex-1 min-w-0 text-left" onClick={()=>setForm({...r,password:''})}><div className="flex items-center gap-2 text-sm text-nms-text font-medium">{r.name}{r.passwordConfigured && r.enabled ? <span title="Radio onboarded"><CheckCircle2 className="w-4 h-4 text-nms-green" /></span> : null}</div><div className="text-[11px] text-nms-text-dim truncate">{r.vendor} · {r.baseUrl} · {r.passwordConfigured && r.enabled ? 'onboarded' : 'onboarding required'}</div></button><button onClick={async()=>{await radioSignalApi.deleteRadio(r.id); toast.success('Radio deleted'); await load();}} className="p-2 text-nms-red hover:bg-nms-red/10 rounded-lg"><Trash2 className="w-4 h-4"/></button></div>)}</div>}
      <div className="p-6 grid md:grid-cols-2 gap-4"><label><span className="nms-label">Radio name</span><input className="nms-input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Baicells – East roof"/></label><label><span className="nms-label">Vendor</span><select className="nms-input" value={form.vendor} onChange={e=>setForm({...form,vendor:e.target.value as any})}><option value="baicells">Baicells</option><option value="generic">Generic JSON API</option></select></label><label><span className="nms-label">Management URL</span><input className="nms-input" value={form.baseUrl} onChange={e=>setForm({...form,baseUrl:e.target.value})} placeholder="https://192.0.2.10"/></label><label><span className="nms-label">Radio username</span><input className="nms-input" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label><span className="nms-label">Radio password</span><input type="password" autoComplete="new-password" className="nms-input" value={form.password ?? ''} onChange={e=>setForm({...form,password:e.target.value})} placeholder={form.passwordConfigured ? 'Leave blank to keep the current password' : 'Password required'}/><span className="text-[10px] text-nms-text-dim">Encrypted with AES-256-GCM on the server and never returned by the API.</span></label><label><span className="nms-label">Metrics API path</span><input className="nms-input font-mono" value={form.metricsPath} onChange={e=>setForm({...form,metricsPath:e.target.value})}/></label><label className="flex items-center gap-3 text-sm text-nms-text"><input type="checkbox" className="nms-checkbox" checked={form.allowSelfSigned} onChange={e=>setForm({...form,allowSelfSigned:e.target.checked})}/> Accept self-signed certificate</label><label className="flex items-center gap-3 text-sm text-nms-text"><input type="checkbox" className="nms-checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/> Enable collection</label></div><div className="px-6 pb-6 flex justify-end"><button onClick={saveRadio} className="nms-btn-primary flex items-center gap-2"><Plus className="w-4 h-4"/> Save radio</button></div></div></div>}
  </div>;
}
