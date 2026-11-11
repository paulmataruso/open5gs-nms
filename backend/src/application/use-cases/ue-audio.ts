import { createHash } from 'crypto';
import { amrFrames, evsFrames, speechFile, codecProblem, parameter, type CodecDescription, type SpeechCodec } from './ue-audio-codecs';
import { decodeSpeech } from './ue-codec-runtime';
import { SrtpDecoder, type SrtpInput } from './ue-srtp';
export interface RtpPacket { frame:number; time:number; src:string; dst:string; srcPort:string; dstPort:string; ssrc:string; pt:number; timestamp:number; payload:string; raw?:string; encrypted?:boolean; description?:CodecDescription; streamId?:string; }
export function parseRtp(output:string):RtpPacket[] {
 return output.split('\n').filter(Boolean).map(line=>{
  const [frame,time,src,dst,srcPort,dstPort,ssrc,pt,timestamp,payload,raw,encrypted]=line.split('\t');
  return {frame:Number(frame),time:Number(time),src,dst,srcPort,dstPort,ssrc,pt:Number(pt),timestamp:Number(timestamp),payload:(payload??'').replace(/:/g,''),raw:raw?.replace(/:/g,''),encrypted:!!encrypted};
 }).filter(p=>p.frame>0 && p.ssrc && Number.isFinite(p.time) && /^[a-f0-9]*$/i.test(p.payload));
}
export const streamKey=(p:RtpPacket)=>p.streamId??[p.src,p.srcPort,p.dst,p.dstPort,p.ssrc,p.pt,...(p.description?[createHash('sha256').update(JSON.stringify(p.description)).digest('hex').slice(0,12)]:[])].join('|');
export function decodeG711(value:number,pt:number):number {
 if(pt===0){const u=(~value)&255;const sample=(((u&15)<<3)+132)<<(u>>4&7);return (u&128)?132-sample:sample-132;}
 const a=value^85;let sample=(a&15)<<4;const exponent=a>>4&7;
 sample=exponent===0?sample+8:exponent===1?sample+264:(sample+264)<<(exponent-1);
 return (a&128)?sample:-sample;
}
export function audioWindow(packets:RtpPacket[],selected:string,after:number) {
 const groups=new Map<string,RtpPacket[]>();
 for(const p of packets){const key=streamKey(p);const list=groups.get(key)??[];list.push(p);groups.set(key,list);}
 const streams=[...groups].slice(0,100).map(([id,list])=>({id,src:list[0].src,dst:list[0].dst,srcPort:list[0].srcPort,dstPort:list[0].dstPort,ssrc:list[0].ssrc,pt:list[0].pt,codec:list[0].pt===0?'PCMU':list[0].pt===8?'PCMA':'Unsupported / dynamic PT '+list[0].pt,supported:[0,8].includes(list[0].pt),packets:list.length}));
 const id=selected || streams.find(s=>s.supported)?.id || streams[0]?.id || '';
 const all=groups.get(id)??[];const end=all[all.length-1]?.time??0;
 // A bounded 8-second jitter buffer. Late packets outside it are skipped.
 const window=all.filter(p=>p.frame>after && p.time>=end-8);
 const cursor=all.reduce((n,p)=>Math.max(n,p.frame),after);
 const supported=streams.find(s=>s.id===id)?.supported??false;
 const samples:number[]=[];let next:number|undefined;const seen=new Set<number>();
 for(const p of window){
  if(!supported || seen.has(p.timestamp))continue;seen.add(p.timestamp);
  if(next!==undefined){const gap=(p.timestamp-next)|0;if(gap<0)continue;if(gap<=8000)for(let i=0;i<gap;i++)samples.push(0);}
  const payload=Buffer.from(p.payload,'hex');for(const byte of payload)samples.push(decodeG711(byte,p.pt));
  next=(p.timestamp+payload.length)>>>0;if(samples.length>=80000)break;
 }
 const pcm=Buffer.alloc(samples.length*2);samples.forEach((sample,i)=>pcm.writeInt16LE(sample,i*2));
 return {streams,selected:id,cursor,sampleRate:8000,pcm:pcm.toString('base64'),seconds:samples.length/8000,skipped:all.some(p=>p.frame>after && p.time<end-8)};
}

export interface AudioOptions {autoKey?:boolean;codec?:'auto'|SpeechCodec;octetAlign?:'auto'|'0'|'1';hfOnly?:'auto'|'0'|'1';srtp?:SrtpInput;}
export interface InstalledCodecs {amr:boolean;amrWb:boolean;evs:boolean;}
export async function renderAudio(packets:RtpPacket[],selected:string,after:number,options:AudioOptions={},tools:InstalledCodecs={amr:false,amrWb:false,evs:false}) {
 if(!['auto','PCMU','PCMA','AMR','AMR-WB','EVS'].includes(options.codec??'auto') || !['auto','0','1'].includes(options.octetAlign??'auto') || !['auto','0','1'].includes(options.hfOnly??'auto'))throw new Error('Invalid codec or payload format');
 const groups=new Map<string,RtpPacket[]>();
 for(const p of packets){const key=streamKey(p);const group=groups.get(key)??[];group.push(p);groups.set(key,group);}
 const describe=(p:RtpPacket):CodecDescription=>p.description??{codec:p.pt===0?'PCMU':p.pt===8?'PCMA':'PT '+p.pt,clock:8000,channels:1,fmtp:'',encrypted:!!p.encrypted};
 const available=(d:CodecDescription)=>d.codec==='AMR'?tools.amr:d.codec==='AMR-WB'?tools.amrWb:d.codec==='EVS'?tools.evs:['PCMU','PCMA'].includes(d.codec);
 const id=selected || [...groups].find(([,g])=>!codecProblem(describe(g[0])) && available(describe(g[0])))?.[0] || groups.keys().next().value || '';
 const streams=[...groups].slice(0,100).map(([key,list])=>{
  let description={...describe(list[0])};
  if(key===id && options.codec && options.codec!=='auto')description={...description,codec:options.codec,clock:['AMR-WB','EVS'].includes(options.codec)?16000:8000,fmtp:description.codec===options.codec?description.fmtp:'',channels:1};
  if(key===id && options.octetAlign && options.octetAlign!=='auto')description.fmtp+=';octet-align='+options.octetAlign;
  if(key===id && options.hfOnly && options.hfOnly!=='auto')description.fmtp+=';hf-only='+options.hfOnly;
  // Last explicit overrides win without modifying captured SDP.
  if(key===id && options.octetAlign && options.octetAlign!=='auto')description.fmtp=description.fmtp.replace(/(?:^|;)\s*octet-align\s*=\s*[^;]+/gi,'')+';octet-align='+options.octetAlign;
  if(key===id && options.hfOnly && options.hfOnly!=='auto')description.fmtp=description.fmtp.replace(/(?:^|;)\s*hf-only\s*=\s*[^;]+/gi,'')+';hf-only='+options.hfOnly;
  description.encrypted ||= list.some(p=>p.encrypted) || (key===id && !!options.srtp);
  const reason=codecProblem(description) || (!available(description)?'Install the '+description.codec+' decoder':undefined) || (description.encrypted && !(key===id && options.srtp)?'SRTP requires this stream’s master key, salt and suite':undefined);
  return {id:key,src:list[0].src,dst:list[0].dst,srcPort:list[0].srcPort,dstPort:list[0].dstPort,ssrc:list[0].ssrc,pt:list[0].pt,codec:description.codec,encrypted:description.encrypted,fmtp:description.fmtp,clock:description.clock,supported:!reason,reason,packets:list.length,description};
 });
 const chosen=streams.find(s=>s.id===id),all=groups.get(id)??[],end=all[all.length-1]?.time??0;
 const cursor=all.reduce((n,p)=>Math.max(n,p.frame),after),sampleRate=chosen?.codec==='EVS'?48000:chosen?.codec==='AMR-WB'?16000:8000;
 const result={streams:streams.map(({description,...s})=>s),selected:id,cursor,sampleRate,pcm:'',seconds:0,skipped:all.some(p=>p.frame>after && p.time<end-8),notice:chosen?.reason??''};
 if(!chosen?.supported || !all.some(p=>p.frame>after && p.time>=end-8))return result;
 let decoded=all;
 if(chosen.encrypted){
  const decoder=new SrtpDecoder(options.srtp!);
  try{decoded=all.map(p=>{if(!p.raw)throw new Error('Full UDP payload is required for SRTP authentication');return {...p,payload:decoder.decode(Buffer.from(p.raw,'hex')).toString('hex')};});}finally{decoder.destroy();}
 }
 const window=decoded.filter(p=>p.time>=end-8),description=chosen.description,codec=description.codec as SpeechCodec;
 const frames:Buffer[]=[],pcm:number[]=[];let next:number|undefined,units=0,skipUnits=0;const seen=new Set<number>();
 for(const p of window){
  if(seen.has(p.timestamp))continue;seen.add(p.timestamp);
  const gap=next===undefined?0:(p.timestamp-next)|0;if(gap<0)continue;
  if(codec==='PCMU' || codec==='PCMA'){
   if(gap>0 && gap<=8000){for(let i=0;i<gap;i++)pcm.push(0);units+=gap;}
   const data=Buffer.from(p.payload,'hex');for(const byte of data)pcm.push(decodeG711(byte,codec==='PCMU'?0:8));units+=data.length;next=(p.timestamp+data.length)>>>0;
  }else{
   const perFrame=description.clock/50;
   if(gap>0 && gap<=description.clock){const lost=Math.floor(gap/perFrame);for(let i=0;i<lost;i++)frames.push(Buffer.from([codec==='EVS'?14:0x78]));units+=lost;}
   const data=Buffer.from(p.payload,'hex');
   const unpacked=codec==='EVS'?evsFrames(data,parameter(description.fmtp,'hf-only')==='1'):amrFrames(data,codec==='AMR-WB',parameter(description.fmtp,'octet-align')==='1');
   frames.push(...unpacked);units+=unpacked.length;next=(p.timestamp+perFrame*unpacked.length)>>>0;
  }
  if(p.frame<=after)skipUnits=units;
  if(units>(codec==='PCMU'||codec==='PCMA'?80000:500))throw new Error('Audio window exceeds ten seconds');
 }
 let output:Buffer;
 if(codec==='PCMU'||codec==='PCMA'){output=Buffer.alloc(pcm.length*2);pcm.forEach((s,i)=>output.writeInt16LE(s,i*2));output=output.subarray(skipUnits*2);}
 else{
  if(!frames.length || units===skipUnits)return result;
  const decoded=await decodeSpeech(codec,speechFile(codec,frames));
  output=decoded.pcm.subarray(skipUnits*(sampleRate/50)*2);
 }
 return {...result,pcm:output.toString('base64'),seconds:output.length/2/sampleRate};
}
