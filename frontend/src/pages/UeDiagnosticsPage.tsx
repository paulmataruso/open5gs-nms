import { UeAudioPanel } from '../components/pcap/UeAudioPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Download, Play, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { ueDiagnosticsApi, type DiagnosticTarget, type DiagnosticSnapshot, type DiagnosticDependencies } from '../api/ueDiagnostics';
import { pcapApi, type HostInterface, type PcapManifest, type PacketTreeNode } from '../api/pcap';
import { PacketDetailTree } from '../components/pcap/PacketDetailTree';
import { useAuth } from '../contexts/AuthContext';

const bytes=(value:number)=>value>=1048576?(value/1048576).toFixed(2)+' MB':value>=1024?(value/1024).toFixed(1)+' KB':value+' B';
const rate=(value:number)=>value>=1000000?(value/1000000).toFixed(2)+' Mbps':value>=1000?(value/1000).toFixed(1)+' Kbps':Math.round(value)+' bps';
const endpoint=(address:string,port:string)=>port?(address.includes(':')?'['+address+']':address)+':'+port:address;
const running=(capture?:PcapManifest)=>!!capture && ['starting','running','stopping'].includes(capture.status);
const message=(error:any)=>error?.response?.data?.error || error?.message || 'Request failed';
export function UeDiagnosticsPage():JSX.Element {
 const {user}=useAuth();
 const admin=user?.role==='admin';
 const [dependencies,setDependencies]=useState<DiagnosticDependencies|null>(null);
 const [installing,setInstalling]=useState(false);
 useEffect(()=>{if(admin)void ueDiagnosticsApi.dependencies().then(setDependencies).catch(()=>{});},[admin]);
 const [targets,setTargets]=useState<DiagnosticTarget[]>([]);
 const [interfaces,setInterfaces]=useState<HostInterface[]>([]);
 const [captures,setCaptures]=useState<PcapManifest[]>([]);
 const [target,setTarget]=useState('manual');
 const [manualIps,setManualIps]=useState('');
 const [iface,setIface]=useState('auto');
 const [duration,setDuration]=useState(60);
 const [size,setSize]=useState(10);
 const [captureId,setCaptureId]=useState('');
 const [snapshot,setSnapshot]=useState<DiagnosticSnapshot|null>(null);
 const [view,setView]=useState<'torch'|'packets'|'console'|'audio'>('torch');
 const [filter,setFilter]=useState('');
 const [appliedFilter,setAppliedFilter]=useState('');
 const [paused,setPaused]=useState(false);
 const [autoScroll,setAutoScroll]=useState(true);
 const consoleRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(view==='console' && autoScroll && consoleRef.current)consoleRef.current.scrollTop=consoleRef.current.scrollHeight;},[snapshot,view,autoScroll]);
 const [loading,setLoading]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const [frame,setFrame]=useState<number|null>(null);
 const [tree,setTree]=useState<PacketTreeNode[]>([]);
 const [hex,setHex]=useState('');
 const [detailLoading,setDetailLoading]=useState(false);
 const [detailError,setDetailError]=useState('');
 const requestSeq=useRef(0),detailSeq=useRef(0);
 const selectedCapture=snapshot?.capture.id===captureId?snapshot.capture:captures.find(c=>c.id===captureId);
 const selectedTarget=targets.find(t=>t.imsi===target);
 const load=useCallback(async()=>{
  try{const data=await ueDiagnosticsApi.overview();setTargets(data.targets);setInterfaces(data.interfaces);setCaptures(data.captures);
   setCaptureId(previous=>data.captures.some(c=>c.id===previous)?previous:data.captures.find(running)?.id || data.captures[0]?.id || '');
  }catch(e){setError(message(e));}
 },[]);
 useEffect(()=>{if(!admin)return;void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},10000);return()=>clearInterval(timer);},[admin,load]);
 useEffect(()=>{
  if(!admin)return;
  const seq=++requestSeq.current;let cancelled=false,inFlight=false,live=true;
  setSnapshot(null);setFrame(null);setTree([]);setHex('');setDetailError('');setDetailLoading(false);++detailSeq.current;
  if(!captureId){setLoading(false);return;}
  const refresh=async()=>{
   if(inFlight || cancelled)return;inFlight=true;setLoading(true);
   try{const next=await ueDiagnosticsApi.snapshot(captureId,appliedFilter);if(!cancelled && seq===requestSeq.current){setSnapshot(next);live=next.live;setError('');}}
   catch(e){if(!cancelled)setError(message(e));}
   finally{inFlight=false;if(!cancelled)setLoading(false);}
  };
  void refresh();
  const timer=setInterval(()=>{if(live && !paused && document.visibilityState==='visible')void refresh();},3000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[admin,captureId,appliedFilter,paused,revision]);
 const start=async()=>{
  setBusy(true);setError('');
  try{const capture=await ueDiagnosticsApi.start({imsi:target==='manual'?undefined:target,
   addresses:target==='manual'?manualIps.split(',').map(ip=>ip.trim()).filter(Boolean):selectedTarget?.sessions.map(s=>s.ip),
   interface:iface,durationSeconds:duration,sizeMb:size});
   setCaptureId(capture.id);setSnapshot(null);setAppliedFilter('');setFilter('');setPaused(false);setRevision(r=>r+1);await load();toast.success('UE capture started');
  }catch(e){setError(message(e));}finally{setBusy(false);}
 };
 const stop=async(id:string)=>{
  setBusy(true);
  try{await ueDiagnosticsApi.stop(id);await load();setRevision(r=>r+1);toast.success('Capture stopped. PCAPNG is ready to download.');}
  catch(e){setError(message(e));}finally{setBusy(false);}
 };
 const removeCapture=async(capture:PcapManifest)=>{
  if(busy || running(capture))return;
  if(!window.confirm('Permanently delete this capture and its PCAPNG file? Download it first if you need to keep a copy.'))return;
  setBusy(true);setError('');
  try{await pcapApi.delete(capture.id);
   setCaptures(previous=>previous.filter(c=>c.id!==capture.id));
   if(captureId===capture.id){++requestSeq.current;++detailSeq.current;setCaptureId('');setSnapshot(null);setFrame(null);setTree([]);setHex('');}
   await load();toast.success('Capture deleted');
  }catch(e){setError(message(e));}finally{setBusy(false);}
 };
 const selectPacket=async(number:number)=>{
  const seq=++detailSeq.current;setFrame(number);setTree([]);setHex('');setDetailLoading(true);setDetailError('');
  try{const detail=await pcapApi.getPacketDetail(captureId,number);if(seq===detailSeq.current){setTree(detail.tree);setHex(detail.hex);}}
  catch(e){if(seq===detailSeq.current)setDetailError(message(e));}finally{if(seq===detailSeq.current)setDetailLoading(false);}
 };
 if(!admin)return <div className="p-6"><h1 className="text-xl font-semibold">UE Diagnostics</h1><p className="mt-3 text-sm text-nms-text-dim">An administrator account is required to capture and inspect packets.</p></div>;
 return <div className="p-4 md:p-6 space-y-5">
  <header className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-nms-accent uppercase tracking-widest">UE traffic inspection</div><h1 className="mt-1 text-2xl font-display font-semibold">UE Diagnostics</h1><p className="mt-1 text-sm text-nms-text-dim">Torch flows, live packet decoding and downloadable PCAPNG captures.</p></div><Activity className="w-7 h-7 text-nms-accent"/></header>
  {error && <div role="alert" className="rounded-xl border border-nms-red/30 bg-nms-red/10 p-3 text-xs text-nms-red">{error}</div>}
  <section className="nms-card flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-nms-text-dim">Capture tools · decoder: {dependencies?.tshark?'installed':'not available'} · host capture: {dependencies?.dumpcap?'installed':'not available'} · G.711: built in · AMR: {dependencies?.amr?'ready':'missing'} · AMR-WB: {dependencies?.amrWb?'ready':'missing'} · EVS: {dependencies?.evs?'ready':'missing'}</div><button className="nms-btn-ghost text-xs" disabled={installing||dependencies?.ready} onClick={async()=>{setInstalling(true);try{setDependencies(await ueDiagnosticsApi.install());toast.success('Capture tools are installed');}catch(e){setError(message(e));}finally{setInstalling(false);}}}>{installing?'Installing capture tools…':dependencies?.ready?'Tools ready':'Check & install missing tools'}</button></section>
  <section className="nms-card space-y-4">
   <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
    <label className="md:col-span-2"><span className="nms-label">UE / target</span><select aria-label="Diagnostic UE" className="nms-input" value={target} onChange={e=>setTarget(e.target.value)}><option value="manual">Manual IP address</option>{targets.map(t=><option key={t.imsi} value={t.imsi}>{t.nickname || t.imsi} · {t.imsi} · {t.sessions.map(s=>s.ip).join(', ')}</option>)}</select></label>
    <label><span className="nms-label">Capture interface</span><select aria-label="Capture interface" className="nms-input" value={iface} onChange={e=>setIface(e.target.value)}><option value="auto">Auto · route to UE</option><option value="any">Any interface</option>{interfaces.map(i=><option key={i.name} value={i.name}>{i.name} {i.ip?'· '+i.ip:''}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-2"><label><span className="nms-label">Max seconds</span><input aria-label="Capture duration seconds" type="number" min={5} max={3600} className="nms-input" value={duration} onChange={e=>setDuration(Number(e.target.value))}/></label><label><span className="nms-label">Max MB</span><input aria-label="Capture size MB" type="number" min={1} max={50} className="nms-input" value={size} onChange={e=>setSize(Number(e.target.value))}/></label></div>
   </div>
   {target==='manual'?<label className="block"><span className="nms-label">UE IP addresses · comma separated</span><input aria-label="Manual UE IP addresses" className="nms-input font-mono" value={manualIps} onChange={e=>setManualIps(e.target.value)} placeholder="10.45.0.2, 2001:db8::2"/></label>:<p className="text-xs text-nms-text-dim">{selectedTarget?.sessions.map(s=>s.apn+': '+s.ip).join(' · ') || 'Refresh targets if the UE session has changed.'}</p>}
   <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-nms-text-dim max-w-3xl">Captures traffic visible on the Open5GS server. Auto selects the routed interface for the UE IP. Use one interface to avoid counting the same packet on multiple interfaces.</p><button onClick={start} disabled={busy || (target==='manual'?!manualIps.trim():!selectedTarget)} className="nms-btn-primary inline-flex items-center gap-2 disabled:opacity-50"><Play className="w-4 h-4"/>Start capture</button></div>
  </section>
  <section className="nms-card space-y-4">
   <div className="flex flex-wrap gap-3 items-center"><select aria-label="Selected diagnostic capture" className="nms-input flex-1 min-w-0" value={captureId} onChange={e=>setCaptureId(e.target.value)}><option value="">Select a capture</option>{captures.map(c=><option key={c.id} value={c.id}>{new Date(c.startedAt).toLocaleString()} · {c.label} · {c.status}</option>)}</select><button aria-label="Refresh diagnostics" className="nms-btn-ghost" onClick={()=>{void load();setRevision(r=>r+1);}}><RefreshCw className={'w-4 h-4 '+(loading?'animate-spin':'')}/></button>
    {selectedCapture && <>{running(selectedCapture)?<button onClick={()=>void stop(selectedCapture.id)} disabled={busy} className="nms-btn-ghost inline-flex items-center gap-2 text-nms-red"><Square className="w-4 h-4"/>Stop</button>:<a className="nms-btn-primary inline-flex items-center gap-2" href={pcapApi.downloadUrl(selectedCapture.id)}><Download className="w-4 h-4"/>Download PCAPNG</a>}</>}
   </div>
   {selectedCapture && <div className="flex flex-wrap justify-between gap-2 text-xs"><span className={running(selectedCapture)?'text-nms-green':'text-nms-text-dim'}>{selectedCapture.status.toUpperCase()} · {selectedCapture.interfaces.join(', ')} · {selectedCapture.ueDiagnostics?.addresses.join(', ')} · limit {selectedCapture.autostopSeconds ?? '—'}s / {Math.round((selectedCapture.autostopFilesizeKb ?? 0)/1024)} MB</span><span className="text-nms-text-dim font-mono break-all">{selectedCapture.bpf}</span></div>}
   {selectedCapture?.error && <p className="text-xs text-nms-amber">{selectedCapture.error}</p>}
   <div className="flex flex-wrap gap-2"><button className="nms-btn-ghost text-xs" onClick={()=>{setFilter('sip || sdp');setAppliedFilter('sip || sdp');setView('console');setRevision(r=>r+1);}}>SIP signaling</button><button className="nms-btn-ghost text-xs" onClick={()=>{setFilter('rtp || rtcp');setAppliedFilter('rtp || rtcp');setView('packets');setRevision(r=>r+1);}}>RTP / RTCP packets</button><button className="nms-btn-ghost text-xs" onClick={()=>{setFilter('');setAppliedFilter('');setRevision(r=>r+1);}}>All packets</button></div>
   <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();setAppliedFilter(filter);setRevision(r=>r+1);}}><Search className="w-4 h-4 mt-3 text-nms-text-dim"/><input aria-label="Wireshark display filter" className="nms-input font-mono flex-1 min-w-0" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Wireshark filter: tcp, udp.port == 53, ip.addr == 10.45.0.2"/><button className="nms-btn-ghost" disabled={!captureId}>Apply filter</button><label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={paused} onChange={e=>setPaused(e.target.checked)}/>Pause display</label></form>
   <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[{label:'Captured packets',value:snapshot?.totalPackets?.toLocaleString() ?? '—',icon:Activity},{label:'Captured bytes',value:snapshot?bytes(snapshot.totalBytes):'—',icon:Download},{label:'UE TX · 5s average',value:snapshot?rate(snapshot.txBps):'—',icon:ArrowUp},{label:'UE RX · 5s average',value:snapshot?rate(snapshot.rxBps):'—',icon:ArrowDown}].map(item=><div key={item.label} className="rounded-xl border border-nms-border p-3"><div className="flex justify-between text-[10px] text-nms-text-dim"><span>{item.label}</span><item.icon className="w-3 h-3"/></div><div className="mt-2 font-display text-xl">{item.value}</div></div>)}</div>
   <div className="flex flex-wrap justify-between gap-2 items-center"><div className="flex gap-2">{(['torch','packets','console','audio'] as const).map(tab=><button key={tab} onClick={()=>setView(tab)} aria-pressed={view===tab} className={view===tab?'nms-btn-primary':'nms-btn-ghost'}>{tab==='torch'?'Torch · flows':tab==='console'?'Console':tab==='audio'?'SIP / Audio':'Packets'}</button>)}</div><span className="text-xs text-nms-text-dim">{paused?'Display paused':snapshot?.live?'Live · refresh every 3s':snapshot?'Saved capture · final 5s traffic window':'Start or select a capture'}</span></div>
   {view==='torch'?<div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-nms-text-dim"><tr>{['Direction','Protocol','Source','Destination','Packets','Bytes','Rate','pps'].map(h=><th key={h} className="text-left p-2 whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{snapshot?.flows.map((f,i)=><tr key={i} className="border-t border-nms-border"><td className="p-2 uppercase">{f.direction}</td><td className="p-2">{f.protocol}</td><td className="p-2 font-mono whitespace-nowrap">{endpoint(f.src,f.srcPort)}</td><td className="p-2 font-mono whitespace-nowrap">{endpoint(f.dst,f.dstPort)}</td><td className="p-2">{f.packets}</td><td className="p-2">{bytes(f.bytes)}</td><td className="p-2">{rate(f.bps)}</td><td className="p-2">{f.pps.toFixed(1)}</td></tr>)}</tbody></table>{!snapshot?.flows.length && <p className="text-center text-nms-text-dim py-10 text-sm">{captureId?'No traffic in the current 5-second window. Packets already captured remain available in the Packets view.':'Choose a UE or IP, then start a capture.'}</p>}</div>
    :view==='audio'?<UeAudioPanel captureId={captureId} toolsReady={dependencies?.ready}/>:view==='console'?<div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-nms-text-dim"><span>Packet console · {snapshot?.live?'refresh every 3s':'saved capture'} · latest 500 matching packets</span><label className="inline-flex items-center gap-2"><input type="checkbox" checked={autoScroll} onChange={e=>setAutoScroll(e.target.checked)}/>Auto-scroll</label></div><div ref={consoleRef} role="log" aria-label="Live packet console" aria-live="off" tabIndex={0} className="h-[440px] overflow-auto rounded-xl border border-nms-border bg-black p-3 font-mono text-[11px] text-green-300"><div className="whitespace-pre min-w-max">{snapshot?.packets.length?[...snapshot.packets].reverse().map(p=><div key={p.frameNumber}><span className="text-gray-400">{new Date(p.timeEpoch*1000).toLocaleTimeString()} #{p.frameNumber}</span>{' '+p.direction.toUpperCase().padEnd(2)+' '+p.protocol.padEnd(8)+' '+endpoint(p.src,p.srcPort)+' → '+endpoint(p.dst,p.dstPort)+'  '+p.length+' B  '+p.info}</div>):<div>Waiting for matching packets… Start a capture or change the display filter.</div>}</div></div></div>:<div className="overflow-x-auto max-h-[440px]"><table className="w-full text-xs"><thead className="text-nms-text-dim sticky top-0 bg-nms-surface"><tr>{['Frame','Time','Source','Destination','Protocol','Bytes','Info'].map(h=><th className="p-2 text-left" key={h}>{h}</th>)}</tr></thead><tbody>{snapshot?.packets.map(p=><tr key={p.frameNumber} className={'border-t border-nms-border '+(frame===p.frameNumber?'bg-nms-accent/10':'hover:bg-nms-surface-2')}><td className="p-2"><button onClick={()=>void selectPacket(p.frameNumber)} className="text-nms-accent underline" aria-label={'Inspect packet '+p.frameNumber}>{p.frameNumber}</button></td><td className="p-2 whitespace-nowrap">{new Date(p.timeEpoch*1000).toLocaleTimeString()}</td><td className="p-2 font-mono whitespace-nowrap">{endpoint(p.src,p.srcPort)}</td><td className="p-2 font-mono whitespace-nowrap">{endpoint(p.dst,p.dstPort)}</td><td className="p-2">{p.protocol}</td><td className="p-2">{p.length}</td><td className="p-2 min-w-64">{p.info}</td></tr>)}</tbody></table>{!snapshot?.packets.length && <p className="text-center py-10 text-nms-text-dim">No packets match the current display filter.</p>}{snapshot?.truncated && <p className="text-xs text-nms-text-dim p-2">Showing the latest 500 matching packets. The download contains the full capture.</p>}</div>}
  </section>
  {frame!==null && <section className="nms-card"><h2 className="font-semibold mb-3">Packet {frame} · protocol details & bytes</h2>{detailLoading?<p className="text-xs text-nms-text-dim">Decoding packet…</p>:detailError?<p role="alert" className="text-xs text-nms-red">{detailError}</p>:<div className="grid xl:grid-cols-2 gap-4"><div className="max-h-96 overflow-auto"><PacketDetailTree tree={tree}/></div><pre className="bg-nms-bg p-3 rounded-xl text-[11px] overflow-auto max-h-96">{hex}</pre></div>}</section>}
  <section className="nms-card"><h2 className="font-semibold mb-3">Saved UE captures</h2>{!captures.length?<p className="text-sm text-nms-text-dim">No UE diagnostic captures yet.</p>:<div className="space-y-2">{captures.map(c=><div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-nms-border p-3"><button className="text-left min-w-0" onClick={()=>setCaptureId(c.id)}><div className="text-xs font-semibold break-words">{c.label}</div><div className="text-[11px] text-nms-text-dim mt-1">{new Date(c.startedAt).toLocaleString()} · {c.status} · {bytes(c.sizeBytes ?? 0)}</div></button>{running(c)?<button onClick={()=>void stop(c.id)} disabled={busy} className="nms-btn-ghost text-xs">Stop</button>:<div className="flex items-center gap-2"><a className="nms-btn-ghost text-xs inline-flex items-center gap-2" href={pcapApi.downloadUrl(c.id)}><Download className="w-3 h-3"/>PCAPNG</a><button onClick={()=>void removeCapture(c)} disabled={busy} aria-label={"Delete capture "+c.id} className="nms-btn-ghost text-xs inline-flex items-center gap-2 text-nms-red disabled:opacity-50"><Trash2 className="w-3 h-3"/>Delete</button></div>}</div>)}</div>}</section>
 </div>;
}
