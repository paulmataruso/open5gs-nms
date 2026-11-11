import { useEffect, useRef, useState } from 'react';
import { ueDiagnosticsApi, type AudioSnapshot } from '../../api/ueDiagnostics';

function pcmBytes(base64:string):Uint8Array {return Uint8Array.from(atob(base64),c=>c.charCodeAt(0));}
function wav(pcm:Uint8Array):Blob {
 const data=new ArrayBuffer(44+pcm.length),v=new DataView(data);
 const text=(at:number,s:string)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
 text(0,'RIFF');v.setUint32(4,36+pcm.length,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,pcm.length,true);new Uint8Array(data,44).set(pcm);return new Blob([data],{type:'audio/wav'});
}
export function UeAudioPanel({captureId}:{captureId:string}) {
 const [data,setData]=useState<AudioSnapshot|null>(null),[stream,setStream]=useState(''),[listening,setListening]=useState(false),[error,setError]=useState(''),[replay,setReplay]=useState(''),[revision,setRevision]=useState(0);
 const context=useRef<AudioContext|null>(null),cursor=useRef(0),schedule=useRef(0),generation=useRef(0);
 useEffect(()=>{cursor.current=0;setData(null);setStream('');setError('');setListening(false);},[captureId]);
 useEffect(()=>()=>{void context.current?.close();context.current=null;schedule.current=0;},[captureId]);
 useEffect(()=>{
  const seq=++generation.current;let cancelled=false,inFlight=false;cursor.current=0;
  const refresh=async()=>{
   if(!captureId || inFlight)return;inFlight=true;
   try{const next=await ueDiagnosticsApi.audio(captureId,stream,listening?cursor.current:0);if(cancelled||seq!==generation.current)return;setData(next);setError('');
    if(listening){cursor.current=next.cursor;const ctx=context.current;if(next.pcm && ctx){const bytes=pcmBytes(next.pcm),view=new DataView(bytes.buffer);const buffer=ctx.createBuffer(1,bytes.length/2,8000),samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
      const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);const at=Math.max(ctx.currentTime+0.1,schedule.current);source.start(at);schedule.current=at+buffer.duration;}}
   }catch(e:any){if(!cancelled){setError(e?.response?.data?.error||e.message);setListening(false);void context.current?.close();context.current=null;}}finally{inFlight=false;}
  };
  void refresh();const timer=listening?setInterval(()=>void refresh(),2000):undefined;
  return()=>{cancelled=true;if(timer)clearInterval(timer);};
 },[captureId,stream,listening,revision]);
 useEffect(()=>{if(!listening && data?.pcm){const url=URL.createObjectURL(wav(pcmBytes(data.pcm)));setReplay(url);return()=>URL.revokeObjectURL(url);}setReplay('');},[data,listening]);
 const stop=()=>{setListening(false);void context.current?.close();context.current=null;schedule.current=0;};
 const listen=async()=>{try{context.current=new AudioContext();await context.current.resume();schedule.current=0;cursor.current=0;setListening(true);}catch(e){setError(String(e));}};
 return <div className="space-y-3"><p className="text-xs text-nms-text-dim">SIP is signaling; audio comes from RTP. Listening supports unencrypted PCMU/PCMA (G.711, 8 kHz). AMR, AMR-WB, other dynamic codecs and encrypted SRTP require external decoding. Capture the IMS APN and start before the call so SIP/SDP is available. Live audio uses a short buffer and refreshes every 2s.</p>
  {error && <p role="alert" className="text-xs text-nms-red">{error}</p>}
  <div className="flex flex-wrap gap-3 items-center"><select aria-label="RTP audio stream" className="nms-input flex-1 min-w-0" value={stream||data?.selected||''} onChange={e=>{stop();setStream(e.target.value);}}><option value="">Select RTP stream</option>{data?.streams.map(s=><option key={s.id} value={s.id}>{s.src}:{s.srcPort} → {s.dst}:{s.dstPort} · {s.codec} · SSRC {s.ssrc} · {s.packets} packets</option>)}</select><button className="nms-btn-primary" disabled={!data?.streams.find(s=>s.id===(stream||data.selected))?.supported} onClick={()=>listening?stop():void listen()}>{listening?'Stop listening':'Listen live'}</button><button className="nms-btn-ghost" disabled={listening} onClick={()=>setRevision(r=>r+1)}>Refresh streams</button></div>
  {!data?.streams.length && <p className="text-sm text-nms-text-dim">No RTP stream detected. SIP packets alone contain no call audio; check the IMS APN, interface and encryption.</p>}
  {data?.streams.length && !data.streams.find(s=>s.id===(stream||data.selected))?.supported?<p className="text-xs text-nms-amber">This RTP payload type cannot be played by the built-in G.711 decoder. Download the PCAPNG for codec analysis.</p>:null}
  {listening && <p role="status" className="text-xs text-nms-green">Listening · {data?.live?'live capture':'saved capture buffer'}{data?.skipped?' · older audio skipped to catch up':''}</p>}
  {replay && <div><p className="text-xs text-nms-text-dim mb-2">Replay latest audio window · {data?.seconds.toFixed(1)}s</p><audio aria-label="Captured RTP audio player" controls src={replay}/></div>}
 </div>;
}
