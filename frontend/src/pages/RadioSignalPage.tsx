import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Antenna, CheckCircle2, ChevronRight, Gauge, Info, Plus, Radar, RadioTower, RefreshCw, Search, Settings2, Signal, Trash2, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { radioSignalApi, type SignalRadio, type SignalUe } from '../api/radioSignal';
import { useAuth } from '../contexts/AuthContext';
import { useEscapeKey } from '../hooks/useKeyboardA11y';
import { SignalGauge } from '../components/common/SignalGauge';

const keyOf = (ue: SignalUe) => ue.radioId + ':' + (ue.imsi || ue.ueId);
const fmt = (v?: number | null, unit = '') => v == null || !Number.isFinite(v) ? '—' : v.toFixed(v % 1 ? 1 : 0) + (unit ? ' ' + unit : '');
const age = (time?: number | null) => {
  if (!time) return 'No radio reading';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  return seconds < 60 ? seconds + 's ago' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : Math.floor(seconds / 3600) + 'h ago';
};
const fresh = (ue: SignalUe) => !!ue.sampledAt && Date.now() - ue.sampledAt < 45000;
const emptyRadio: Partial<SignalRadio> = {
  name: '', vendor: 'baicells', baseUrl: 'https://', username: 'admin',
  password: '', metricsPath: '/api/ue/signals', enabled: true, allowSelfSigned: true,
};
function Fact({ label, value }: { label: string; value?: string | number | null }) {
  return <div className="min-w-0"><dt className="text-[10px] uppercase tracking-wider text-nms-text-dim">{label}</dt><dd className="mt-1 font-mono text-xs text-nms-text break-words">{value == null || value === '' ? '—' : value}</dd></div>;
}
function Metric({ label, value, unit = '' }: { label: string; value?: number | null; unit?: string }) {
  return <div className="rounded-xl border border-nms-border bg-nms-surface-2/40 px-3 py-3"><div className="text-[10px] text-nms-text-dim uppercase tracking-wide">{label}</div><div className="mt-1 text-lg font-display text-nms-text">{fmt(value,unit)}</div></div>;
}
const detailLabels: Record<string,string> = {
  cellIndex: 'Radio cell index', radioUeId: 'Radio UE ID', virtualMac: 'Virtual MAC',
  reportedIp: 'Radio-reported IP', port: 'Radio port', ulSinrReported: 'UL SINR (reported)',
  secondaryDlMcs: 'Secondary DL MCS', primaryDlBlerTb1: 'Primary DL BLER TB1 (%)',
  primaryDlBlerTb2: 'Primary DL BLER TB2 (%)', secondaryDlBlerTb1: 'Secondary DL BLER TB1 (%)',
  secondaryDlBlerTb2: 'Secondary DL BLER TB2 (%)',
};

export function RadioSignalPage(): JSX.Element {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [ues,setUes] = useState<SignalUe[]>([]);
  const [radios,setRadios] = useState<SignalRadio[]>([]);
  const [selectedKey,setSelectedKey] = useState('');
  const [search,setSearch] = useState('');
  const [radioFilter,setRadioFilter] = useState('');
  const [hours,setHours] = useState(1);
  const [loading,setLoading] = useState(true);
  const [polling,setPolling] = useState(false);
  const [auto,setAuto] = useState(true);
  const [error,setError] = useState('');
  const [coreAvailable,setCoreAvailable] = useState(true);
  const [gaugeMetric,setGaugeMetric] = useState<'auto' | 'rssi' | 'rsrp' | 'sinr'>('auto');
  const [configOpen,setConfigOpen] = useState(false);
  const [form,setForm] = useState<Partial<SignalRadio>>(emptyRadio);
  const collecting = useRef(false);
  const requestId = useRef(0);
  useEscapeKey(() => setConfigOpen(false),configOpen);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const data = await radioSignalApi.overview('',hours);
      if (id !== requestId.current) return;
      setUes(data.ues); setRadios(data.radios); setCoreAvailable(data.coreAvailable !== false); setError('');
    } catch { if (id === requestId.current) setError('Unable to load UE measurements. The last displayed data may be stale.'); }
    finally { if (id === requestId.current) setLoading(false); }
  },[hours]);
  const poll = useCallback(async (notify = true) => {
    if (collecting.current) return;
    collecting.current = true; setPolling(true);
    let collectionError = '';
    try {
      const result = await radioSignalApi.poll();
      const failures = result.results.filter(r => !r.success);
      if (notify) {
        if (failures.length) toast.error(failures.length + ' radio(s) could not be read. See source status below.');
        else toast.success(result.results.length + ' radio(s) collected');
      }
    } catch { collectionError = 'Radio collection failed. Check source connectivity and credentials.'; }
    finally { await load(); if (collectionError) setError(collectionError); collecting.current = false; setPolling(false); }
  },[load]);
  useEffect(() => {
    void load();
    return () => { ++requestId.current; };
  },[load]);
  useEffect(() => {
    if (!auto) return;
    const collect = () => { if (document.visibilityState === 'visible') void (admin ? poll(false) : load()); };
    collect();
    const timer = setInterval(collect,15000);
    return () => clearInterval(timer);
  },[auto,admin,poll,load]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ues.filter(ue => (!radioFilter || ue.radioId === radioFilter) &&
      (!q || [ue.imsi,ue.iccid,ue.nickname,ue.msisdn,ue.ueId,ue.radioName,ue.coreIp,ue.imeisv].some(v => String(v ?? '').toLowerCase().includes(q))));
  },[ues,search,radioFilter]);
  const selected = filtered.find(ue => keyOf(ue) === selectedKey) ?? filtered[0];
  const selectedRadio = radios.find(r => r.id === selected?.radioId);
  const activeGaugeMetric = gaugeMetric === 'auto'
    ? selected?.rsrp != null ? 'rsrp' : selected?.rssi != null ? 'rssi' : 'sinr'
    : gaugeMetric;
  const radioIssue = selectedRadio?.lastError;
  const sampled = ues.filter(ue => fresh(ue));
  const sinrs = sampled.map(ue => ue.sinr).filter((v): v is number => v != null && Number.isFinite(v));
  const saveRadio = async () => {
    try { await radioSignalApi.saveRadio(form); setConfigOpen(false); setForm(emptyRadio); toast.success('Radio saved'); await poll(false); }
    catch (e: any) { toast.error(e.response?.data?.error || 'Unable to save radio'); }
  };
  const discover = async () => {
    try { const result = await radioSignalApi.discover(); toast.success(result.discovered.length + ' eNodeB(s) detected'); await load(); setConfigOpen(true); }
    catch { toast.error('Unable to discover connected eNodeBs'); }
  };
  const chart = (selected?.history ?? []).map(p => ({...p,time:new Date(p.sampledAt).toLocaleTimeString()}));
  return <div className="p-4 md:p-6 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="flex items-center gap-2 text-nms-accent text-xs uppercase tracking-[0.2em]"><Antenna className="w-4 h-4" /> Baicells radio monitoring</div><h1 className="mt-2 text-2xl font-display font-semibold">UE Signal</h1><p className="mt-1 text-sm text-nms-text-dim">Per-UE radio measurements, subscriber identity and bearer sessions.</p></div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-2 text-xs text-nms-text-dim"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)} /> Auto · 15s</label>
        {admin && <><button onClick={discover} className="nms-btn-ghost inline-flex items-center gap-2 text-xs"><Radar className="w-4 h-4" /> Discover</button><button onClick={()=>{setForm(emptyRadio);setConfigOpen(true);}} className="nms-btn-ghost inline-flex items-center gap-2 text-xs"><Settings2 className="w-4 h-4" /> Radios</button></>}
        <button onClick={()=>void (admin ? poll() : load())} disabled={polling} className="nms-btn-primary inline-flex items-center gap-2 text-xs"><RefreshCw className={'w-4 h-4 '+(polling?'animate-spin':'')} /> {polling?'Collecting…':'Refresh'}</button>
      </div>
    </header>
    {(error || !coreAvailable) && <div role="alert" className="rounded-xl border border-nms-amber/30 bg-nms-amber/10 p-3 text-xs text-nms-amber">{error || 'Core session data is unavailable. Radio measurements are still shown.'}</div>}
    <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {[{label:'Online UEs',value:ues.length,detail:'Currently reported by radio or connected core',icon:Users},{label:'Fresh radio samples',value:sampled.length,detail:'Received within 45 seconds',icon:Signal},{label:'Radio sources',value:radios.filter(r=>r.enabled).length,detail:radios.filter(r=>r.enabled && r.lastError).length+' source error(s)',icon:RadioTower},{label:'Average UL SINR',value:sinrs.length?fmt(sinrs.reduce((a,b)=>a+b,0)/sinrs.length,'dB'):'—',detail:'Fresh measurements only',icon:Gauge}].map(item=><div key={item.label} className="nms-card"><div className="flex justify-between gap-2 text-xs text-nms-text-dim"><span>{item.label}</span><item.icon className="w-4 h-4 text-nms-accent"/></div><div className="mt-2 text-2xl font-display font-semibold">{item.value}</div><div className="mt-1 text-[11px] text-nms-text-dim">{item.detail}</div></div>)}
    </div>
    <section className="nms-card">
      <h2 className="text-sm font-semibold mb-3">Radio collection</h2>
      {!radios.length && <p className="text-xs text-nms-text-dim">Discover your radios or add their management URL and credentials.</p>}
      <div className="grid lg:grid-cols-2 gap-3">{radios.map(r=><div key={r.id} className="rounded-xl border border-nms-border p-3 flex gap-3 items-start"><span className={'mt-1 w-2 h-2 rounded-full shrink-0 '+(!r.enabled?'bg-nms-text-dim':r.lastError?'bg-nms-red':r.lastPolledAt?'bg-nms-green':'bg-nms-amber')}/><div className="min-w-0 flex-1"><div className="text-xs font-semibold truncate">{r.name}</div><div className="text-[11px] text-nms-text-dim mt-1 break-all">{r.baseUrl}</div><p className="text-[11px] text-nms-text-dim mt-1">{!r.enabled?'Collection disabled':r.lastError?r.lastError:r.lastPolledAt?String(r.ueCount ?? 0)+' UE(s) reported · '+age(r.lastPolledAt):'Waiting for first collection'}</p></div></div>)}</div>
    </section>
    <div className="flex items-start gap-2 rounded-xl bg-nms-accent/5 border border-nms-accent/20 p-3"><Info className="w-4 h-4 text-nms-accent shrink-0"/><p className="text-xs text-nms-text-dim">Baicells reports UL SINR, CQI, MCS, BLER, throughput, UE TX power and path loss. RSSI, RSRP, RSRQ and SNR remain unavailable unless explicitly reported by a source. Only online UEs are shown.</p></div>
    <div className="flex flex-col md:flex-row gap-3"><div className="relative flex-1"><Search className="absolute left-3 top-3 w-4 h-4 text-nms-text-dim"/><input aria-label="Search UEs" className="nms-input pl-10" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search IMSI, ICCID, IMEI, name, IP or radio…"/></div><select aria-label="Filter radio" className="nms-input md:w-64" value={radioFilter} onChange={e=>setRadioFilter(e.target.value)}><option value="">All UEs / radios</option>{radios.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><select aria-label="Time range (hours)" className="nms-input md:w-36" value={hours} onChange={e=>setHours(Number(e.target.value))}><option value={1}>Last hour</option><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={168}>7 days</option></select></div>
    {loading ? <p className="nms-card text-sm text-nms-text-dim">Loading UEs…</p> : !filtered.length ? <div className="nms-card py-12 text-center"><RadioTower className="w-8 h-8 mx-auto text-nms-accent"/><h2 className="mt-4 font-semibold">{ues.length?'No matching UE':'No UE currently online'}</h2><p className="mt-2 text-sm text-nms-text-dim">Check radio collection status and ensure a UE is attached.</p></div> : <div className="grid xl:grid-cols-[330px_minmax(0,1fr)] gap-5">
      <div className="space-y-2 xl:max-h-[1050px] xl:overflow-y-auto">{filtered.map(ue=><button key={keyOf(ue)} onClick={()=>setSelectedKey(keyOf(ue))} className={'w-full text-left rounded-xl border p-4 '+(selected && keyOf(selected)===keyOf(ue)?'border-nms-accent bg-nms-accent/5':'border-nms-border bg-nms-surface')}><div className="flex justify-between gap-2"><span className="font-semibold text-sm truncate">{ue.nickname || ue.imsi || 'UE '+ue.ueId}</span><ChevronRight className="w-4 h-4 text-nms-accent shrink-0"/></div><div className="font-mono text-[11px] text-nms-text-dim mt-1">{ue.imsi || 'IMSI not reported'}</div><div className="grid grid-cols-2 gap-2 mt-3 text-xs"><div><span className="text-nms-text-dim">UE TX power</span><div className="font-mono mt-1">{fmt(ue.txPower,'dBm')}</div></div><div><span className="text-nms-text-dim">UL SINR</span><div className="font-mono mt-1">{fmt(ue.sinr,'dB')}</div></div></div><div className="mt-3 flex items-center justify-between gap-2 text-[10px]"><span className={fresh(ue)?'text-nms-green':'text-nms-text-dim'}>{fresh(ue)?'Radio data received':ue.sampledAt?'Last radio reading':ue.cmState?'Core connected · radio data unavailable':'Radio data unavailable'}</span><span className="text-nms-text-dim">{ue.sampledAt ? age(ue.sampledAt) : ''}</span></div></button>)}</div>
      {selected && <div className="min-w-0 space-y-4">
        <section className="nms-card">
          <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-display font-semibold">{selected.nickname || selected.imsi || 'UE '+selected.ueId}</h2><p className="text-xs text-nms-text-dim mt-1">{selected.radioName} · {age(selected.sampledAt)}</p></div><span className={'text-xs self-start rounded-full border px-3 py-1 '+(fresh(selected)?'border-nms-green/30 text-nms-green':'border-nms-border text-nms-text-dim')}>{fresh(selected)?'Radio data received':selected.sampledAt?'Last radio reading':'Core connected · no radio data'}</span></div>
          <dl className="grid grid-cols-2 lg:grid-cols-3 gap-4 mt-5"><Fact label="IMSI" value={selected.imsi}/><Fact label="ICCID" value={selected.iccid}/><Fact label="MSISDN" value={selected.msisdns?.join(', ') || selected.msisdn}/><Fact label="IMEISV" value={Array.isArray(selected.imeisv)?selected.imeisv.join(', '):selected.imeisv}/><Fact label="SIM type" value={selected.simType}/><Fact label="Subscriber status" value={selected.subscriberStatus===0?'Service granted':selected.subscriberStatus===1?'Barred':undefined}/><Fact label="Core connection" value={selected.cmState}/><Fact label="Registration" value={selected.mmState}/><Fact label="Core UE IP" value={selected.coreIp}/><Fact label="Radio management IP" value={selected.coreRadioIp || selected.radioUrl}/><Fact label="Radio UE / cell ID" value={selected.source==='radio'?selected.ueId:undefined}/><Fact label="Last RF observation" value={selected.sampledAt?new Date(selected.sampledAt).toLocaleString():undefined}/></dl>
          {!selected.imsi && <p className="mt-4 text-xs text-nms-amber">IMSI unavailable. Subscriber details cannot be linked to this radio observation.</p>}
        </section>
        <section className="nms-card">
          {(!selected.sampledAt || radioIssue) && <div role="status" className="mb-4 rounded-xl border border-nms-amber/30 bg-nms-amber/10 p-3 text-xs text-nms-amber">{radioIssue?.includes('login') ? 'Radio authentication failed. The UE is connected to the core, but its radio measurements cannot be read. Check this radio’s login credentials in Radios.' : radioIssue ? 'The UE is connected to the core, but radio collection is failing: ' + radioIssue : 'The UE is connected to the core. Its radio has not returned a per-UE measurement yet.'}</div>}
          <div className="flex items-center justify-between gap-3 mb-4"><h3 className="text-sm font-semibold">Signal strength & quality</h3><select aria-label="Gauge metric" className="nms-input w-28 text-xs" value={gaugeMetric} onChange={e=>setGaugeMetric(e.target.value as 'auto'|'rssi'|'rsrp'|'sinr')}><option value="auto">Auto</option><option value="sinr">UL SINR</option><option value="rssi">RSSI</option><option value="rsrp">RSRP</option></select></div>
          <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4"><SignalGauge value={selected[activeGaugeMetric]} label={activeGaugeMetric === 'sinr' ? 'UL SINR' : activeGaugeMetric.toUpperCase()} unit={activeGaugeMetric === 'sinr' ? 'dB' : 'dBm'} min={activeGaugeMetric === 'sinr' ? -10 : -120} max={activeGaugeMetric === 'sinr' ? 40 : -50}/><div className="grid grid-cols-2 gap-2"><Metric label="RSSI" value={selected.rssi} unit="dBm"/><Metric label="RSRP" value={selected.rsrp} unit="dBm"/><Metric label="RSRQ" value={selected.rsrq} unit="dB"/><Metric label="UL SINR" value={selected.sinr} unit="dB"/><Metric label="SNR" value={selected.snr} unit="dB"/><Metric label="UL BLER" value={selected.bler} unit="%"/></div></div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mt-4"><Metric label="UE TX power" value={selected.txPower} unit="dBm"/><Metric label="Path loss" value={selected.pathLoss} unit="dB"/><Metric label="Primary DL CQI" value={selected.primaryDlCqi}/><Metric label="Secondary DL CQI" value={selected.secondaryDlCqi}/><Metric label="DL MCS" value={selected.dlMcs}/><Metric label="UL MCS" value={selected.ulMcs}/><Metric label="DL throughput" value={selected.dlMbps} unit="Mbps"/><Metric label="UL throughput" value={selected.ulMbps} unit="Mbps"/></div>
          {!!Object.keys(selected.details ?? {}).length && <dl className="mt-4 grid grid-cols-2 lg:grid-cols-3 gap-4">{Object.entries(selected.details ?? {}).map(([key,value])=><Fact key={key} label={detailLabels[key] || key} value={value}/>)}</dl>}
        </section>
        <section className="nms-card"><h3 className="text-sm font-semibold mb-3">APN / bearer sessions</h3>{selected.coreSessions?.map((session,i)=><div key={i} className="text-xs rounded-lg bg-nms-accent/5 p-2 mb-2">Core session: <span className="font-mono">{session.apn} · {session.ip || 'IP unavailable'}</span></div>)}{!selected.sessions?.length?<p className="text-xs text-nms-text-dim">No subscriber session details available.</p>:<div className="space-y-3">{selected.sessions.map((session,i)=><dl key={i} className="rounded-xl border border-nms-border p-3 grid grid-cols-2 lg:grid-cols-3 gap-3"><Fact label="APN / DNN" value={session.apn}/><Fact label="Slice SST / SD" value={session.sst+' / '+(session.sd || '—')}/><Fact label="IP type / QCI" value={(['','IPv4','IPv6','IPv4v6'][session.type] || session.type)+' / '+session.qos.index}/><Fact label="Configured IPv4" value={session.ipv4}/><Fact label="Configured IPv6" value={session.ipv6}/><Fact label="AMBR DL / UL" value={session.ambr.downlink.value+' '+(['bps','Kbps','Mbps','Gbps'][session.ambr.downlink.unit] || '')+' / '+session.ambr.uplink.value+' '+(['bps','Kbps','Mbps','Gbps'][session.ambr.uplink.unit] || '')}/><Fact label="IPv4 framed routes" value={session.ipv4FramedRoutes?.join(', ')}/><Fact label="IPv6 framed routes" value={session.ipv6FramedRoutes?.join(', ')}/></dl>)}</div>}</section>
        <section className="nms-card"><div className="flex justify-between items-center mb-3"><div><h3 className="text-sm font-semibold">Signal history</h3><p className="text-[11px] text-nms-text-dim mt-1">Recorded radio observations</p></div><Activity className="w-4 h-4 text-nms-accent"/></div>{chart.length?<div className="h-72"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chart}><CartesianGrid stroke="rgb(var(--nms-border-rgb))" strokeDasharray="3 3"/><XAxis dataKey="time" fontSize={10}/><YAxis yAxisId="dbm" domain={[-120,-50]} fontSize={10} unit=" dBm"/><YAxis yAxisId="db" orientation="right" fontSize={10} unit=" dB"/><Tooltip contentStyle={{background:'rgb(var(--nms-surface-rgb))',border:'1px solid rgb(var(--nms-border-rgb))',fontSize:11}}/><Legend/><Area yAxisId="dbm" dataKey="rssi" name="RSSI (dBm)" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.1} connectNulls={false}/><Area yAxisId="dbm" dataKey="rsrp" name="RSRP (dBm)" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.1} connectNulls={false}/><Area yAxisId="db" dataKey="sinr" name="UL SINR (dB)" stroke="#34d399" fill="#34d399" fillOpacity={0.1} connectNulls={false}/></AreaChart></ResponsiveContainer></div>:<p className="text-xs text-nms-text-dim py-8 text-center">History will appear when the radio reports this UE.</p>}</section>
      </div>}
    </div>}
    {configOpen && <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) setConfigOpen(false); }}><div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl border border-nms-border bg-nms-surface shadow-2xl"><div className="p-6 border-b border-nms-border flex items-center justify-between"><div><h2 className="font-display text-xl font-semibold text-nms-text">Radio sources</h2><p className="text-xs text-nms-text-dim mt-1">Multi-vendor connectors — shared Baicells profile</p></div><button className="nms-btn-ghost" onClick={() => setConfigOpen(false)}>Close</button></div>
      {!!radios.length && <div className="p-5 border-b border-nms-border space-y-2">{radios.map(r => <div key={r.id} className="flex items-center gap-3 rounded-xl bg-nms-surface-2 p-3"><RadioTower className="w-4 h-4 text-nms-accent"/><button className="flex-1 min-w-0 text-left" onClick={()=>setForm({...r,password:''})}><div className="flex items-center gap-2 text-sm text-nms-text font-medium">{r.name}{r.passwordConfigured && r.enabled ? <span title="Radio onboarded"><CheckCircle2 className="w-4 h-4 text-nms-green" /></span> : null}</div><div className="text-[11px] text-nms-text-dim truncate">{r.vendor} · {r.baseUrl} · {r.passwordConfigured && r.enabled ? 'onboarded' : 'onboarding required'}</div></button><button aria-label="Delete radio" onClick={async()=>{await radioSignalApi.deleteRadio(r.id); toast.success('Radio deleted'); await load();}} className="p-2 text-nms-red hover:bg-nms-red/10 rounded-lg"><Trash2 className="w-4 h-4"/></button></div>)}</div>}
      <div className="p-6 grid md:grid-cols-2 gap-4"><label><span className="nms-label">Radio name</span><input className="nms-input" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Baicells – East roof"/></label><label><span className="nms-label">Vendor</span><select className="nms-input" value={form.vendor} onChange={e=>setForm({...form,vendor:e.target.value as any})}><option value="baicells">Baicells</option><option value="generic">Generic JSON API</option></select></label><label><span className="nms-label">Management URL</span><input className="nms-input" value={form.baseUrl} onChange={e=>setForm({...form,baseUrl:e.target.value})} placeholder="https://192.0.2.10"/></label><label><span className="nms-label">Radio username</span><input className="nms-input" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label><span className="nms-label">Radio password</span><input type="password" autoComplete="new-password" className="nms-input" value={form.password ?? ''} onChange={e=>setForm({...form,password:e.target.value})} placeholder={form.passwordConfigured ? 'Leave blank to keep the current password' : 'Password required'}/><span className="text-[10px] text-nms-text-dim">Encrypted with AES-256-GCM on the server and never returned by the API.</span></label><label><span className="nms-label">Metrics API path</span><input className="nms-input font-mono" value={form.metricsPath} onChange={e=>setForm({...form,metricsPath:e.target.value})}/></label><label className="flex items-center gap-3 text-sm text-nms-text"><input type="checkbox" className="nms-checkbox" checked={form.allowSelfSigned} onChange={e=>setForm({...form,allowSelfSigned:e.target.checked})}/> Accept self-signed certificate</label><label className="flex items-center gap-3 text-sm text-nms-text"><input type="checkbox" className="nms-checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/> Enable collection</label></div><div className="px-6 pb-6 flex justify-end"><button onClick={saveRadio} className="nms-btn-primary flex items-center gap-2"><Plus className="w-4 h-4"/> Save radio</button></div></div></div>}
  </div>;
}
