import { useEffect, useRef, useState } from 'react';
import { ueDiagnosticsApi, type AudioSnapshot, type AudioOptions } from '../../api/ueDiagnostics';

function pcmBytes(base64:string):Uint8Array {return Uint8Array.from(atob(base64),c=>c.charCodeAt(0));}
const defaults:AudioOptions={autoKey:true,codec:"auto",octetAlign:"auto",hfOnly:"auto"};
function wav(pcm:Uint8Array,sampleRate:number):Blob {
 const data=new ArrayBuffer(44+pcm.length),v=new DataView(data);
 const text=(at:number,s:string)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
 text(0,'RIFF');v.setUint32(4,36+pcm.length,true);text(8,'WAVE');text(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,pcm.length,true);new Uint8Array(data,44).set(pcm);return new Blob([data],{type:'audio/wav'});
}
export function UeAudioPanel({captureId,toolsReady}:{captureId:string;toolsReady?:boolean}) {
 const [data,setData]=useState<AudioSnapshot|null>(null),[stream,setStream]=useState(''),[listening,setListening]=useState(false),[error,setError]=useState(''),[replay,setReplay]=useState(''),[revision,setRevision]=useState(0);
 const [options,setOptions]=useState<AudioOptions>(defaults);
 const [codec,setCodec]=useState<AudioOptions['codec']>('auto'),[alignment,setAlignment]=useState<AudioOptions['octetAlign']>('auto'),[header,setHeader]=useState<AudioOptions['hfOnly']>('auto');
 const [autoKey,setAutoKey]=useState(true);
 const [secure,setSecure]=useState(false),[key,setKey]=useState(''),[suite,setSuite]=useState<'AES_CM_128_HMAC_SHA1_80'|'AES_CM_128_HMAC_SHA1_32'>('AES_CM_128_HMAC_SHA1_80'),[roc,setRoc]=useState(0);
 const context=useRef<AudioContext|null>(null),cursor=useRef(0),schedule=useRef(0),generation=useRef(0);
 useEffect(()=>{cursor.current=0;setData(null);setStream('');setError('');setListening(false);setOptions(defaults);setCodec('auto');setAlignment('auto');setHeader('auto');setAutoKey(true);setSecure(false);setKey('');setRoc(0);},[captureId]);
 useEffect(()=>()=>{void context.current?.close();context.current=null;schedule.current=0;},[captureId]);
 useEffect(()=>{
  const seq=++generation.current;let cancelled=false,inFlight=false;cursor.current=0;
  const refresh=async()=>{
   if(!captureId || inFlight)return;inFlight=true;
   try{const next=await ueDiagnosticsApi.audio(captureId,stream,listening?cursor.current:0,options);if(cancelled||seq!==generation.current)return;setData(next);setError('');
    if(listening){cursor.current=next.cursor;const ctx=context.current;if(next.pcm && ctx){const bytes=pcmBytes(next.pcm),view=new DataView(bytes.buffer);const buffer=ctx.createBuffer(1,bytes.length/2,next.sampleRate),samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
      const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);const at=Math.max(ctx.currentTime+0.1,schedule.current);source.start(at);schedule.current=at+buffer.duration;}}
   }catch(e:any){if(!cancelled){setError(e?.response?.data?.error||e.message);setListening(false);void context.current?.close();context.current=null;}}finally{inFlight=false;}
  };
  void refresh();const timer=listening?setInterval(()=>void refresh(),2000):undefined;
  return()=>{cancelled=true;if(timer)clearInterval(timer);};
 },[captureId,stream,listening,revision,options,toolsReady]);
 useEffect(()=>{if(!listening && data?.pcm){const url=URL.createObjectURL(wav(pcmBytes(data.pcm),data.sampleRate));setReplay(url);return()=>URL.revokeObjectURL(url);}setReplay('');},[data,listening]);
 const stop=()=>{setListening(false);void context.current?.close();context.current=null;schedule.current=0;};
 const listen=async()=>{try{context.current=new AudioContext();await context.current.resume();schedule.current=0;cursor.current=0;setListening(true);}catch(e){setError(String(e));}};
 return <div className="space-y-3"><p className="text-xs text-nms-text-dim">Audio: G.711, AMR, AMR-WB and EVS (primary / AMR-WB IO), with the codec and payload format read from captured SIP/SDP. Capture the IMS APN before the call. Live playback uses a short buffer and refreshes every 2s. SRTP keys are matched automatically from captured SDES or existing IMS traces when available; a manual key can also be supplied.</p>
  {error && <p role="alert" className="text-xs text-nms-red">{error}</p>}
  <div className="flex flex-wrap gap-3 items-center"><select aria-label="RTP audio stream" className="nms-input flex-1 min-w-0" value={stream||data?.selected||''} onChange={e=>{stop();setStream(e.target.value);setKey('');setSecure(false);setOptions(previous=>({...previous,srtp:undefined}));setData(null);}}><option value="">Select RTP stream</option>{data?.streams.map(s=><option key={s.id} value={s.id}>{s.src}:{s.srcPort} → {s.dst}:{s.dstPort} · {s.codec}{s.encrypted?" · SRTP":""} · SSRC {s.ssrc} · {s.packets} packets</option>)}</select><button className="nms-btn-primary" disabled={!listening && !data?.streams.find(s=>s.id===(stream||data.selected))?.supported} onClick={()=>listening?stop():void listen()}>{listening?'Stop listening':'Listen live'}</button><button className="nms-btn-ghost" disabled={listening} onClick={()=>setRevision(r=>r+1)}>Refresh streams</button></div>
  <details className="rounded-xl border border-nms-border p-3"><summary className="cursor-pointer text-xs font-semibold">Codec settings / SRTP key</summary><div className="mt-3 grid md:grid-cols-3 gap-3 text-xs">
   <label>Codec<select aria-label="Audio codec" className="nms-input mt-1" value={codec} onChange={e=>setCodec(e.target.value as AudioOptions['codec'])}>{['auto','PCMU','PCMA','AMR','AMR-WB','EVS'].map(c=><option key={c} value={c}>{c==='auto'?'Auto · captured SDP':c}</option>)}</select></label>
   <label>AMR payload format<select aria-label="AMR payload format" className="nms-input mt-1" value={alignment} onChange={e=>setAlignment(e.target.value as AudioOptions['octetAlign'])}><option value="auto">Auto · SDP (default bandwidth-efficient)</option><option value="0">Bandwidth-efficient</option><option value="1">Octet-aligned</option></select></label>
   <label>EVS payload format<select aria-label="EVS payload format" className="nms-input mt-1" value={header} onChange={e=>setHeader(e.target.value as AudioOptions['hfOnly'])}><option value="auto">Auto · SDP</option><option value="0">Compact / header-full</option><option value="1">Header-full only</option></select></label>
   <label className="md:col-span-3 flex gap-2 items-center"><input aria-label="Find SRTP key automatically" type="checkbox" checked={autoKey} onChange={e=>setAutoKey(e.target.checked)}/>Find the SRTP key automatically in captured SDP or existing IMS SIP traces</label>
   <label className="md:col-span-3 flex gap-2 items-center"><input aria-label="Decrypt SRTP" type="checkbox" checked={secure} onChange={e=>setSecure(e.target.checked)}/>Use a manual SRTP session key</label>
   {secure && <><label className="md:col-span-3">SRTP master key + salt (30 bytes, base64)<input aria-label="SRTP master key and salt" type="password" autoComplete="off" spellCheck={false} className="nms-input font-mono mt-1" value={key} onChange={e=>setKey(e.target.value)} /></label><label>SRTP suite<select aria-label="SRTP suite" className="nms-input mt-1" value={suite} onChange={e=>setSuite(e.target.value as typeof suite)}><option>AES_CM_128_HMAC_SHA1_80</option><option>AES_CM_128_HMAC_SHA1_32</option></select></label><label>Initial rollover counter<input aria-label="SRTP initial rollover counter" type="number" min={0} max={4294967295} className="nms-input mt-1" value={roc} onChange={e=>setRoc(Number(e.target.value))}/></label><p className="md:col-span-3 text-nms-text-dim">The key is sent only in audio POST requests and is not saved. Use the key for the selected direction. AES-CM/HMAC-SHA1, KDR=0 and no MKI are supported. DTLS key exchange and IPsec/ESP decryption are separate.</p></>}
   <button className="nms-btn-ghost" onClick={()=>{stop();setData(null);setOptions({autoKey,codec,octetAlign:alignment,hfOnly:header,...(secure?{srtp:{key:key.trim(),suite,roc}}:{})});setRevision(r=>r+1);}}>Apply audio settings</button><p className="md:col-span-2 text-nms-text-dim">Mono AMR/AMR-WB: octet-aligned or bandwidth-efficient, without interleaving, CRC or robust sorting. Missing tools can be installed above.</p>
  </div></details>
  {data && data.keySource!=='none' && <p role="status" className="text-xs text-nms-green">SRTP key source: {data.keySource} · authenticated</p>}
  {data?.notice && <p role="status" className="text-xs text-nms-amber">{data.notice}</p>}
  {!data?.streams.length && <p className="text-sm text-nms-text-dim">No RTP stream detected. SIP packets alone contain no call audio; check the IMS APN, interface and encryption.</p>}
  {data?.streams.length && !data.streams.find(s=>s.id===(stream||data.selected))?.supported?<p className="text-xs text-nms-amber">{data.streams.find(s=>s.id===(stream||data.selected))?.reason || 'This stream cannot be decoded with the current settings.'}</p>:null}
  {listening && <p role="status" className="text-xs text-nms-green">Listening · {data?.live?'live capture':'saved capture buffer'}{data?.skipped?' · older audio skipped to catch up':''}</p>}
  {replay && <div><p className="text-xs text-nms-text-dim mb-2">Replay latest audio window · {data?.seconds.toFixed(1)}s</p><audio aria-label="Captured RTP audio player" controls src={replay}/></div>}
 </div>;
}
