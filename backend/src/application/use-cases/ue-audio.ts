// G.711 decoding is built in: no external codec process or call modification.
export interface RtpPacket { frame:number; time:number; src:string; dst:string; srcPort:string; dstPort:string; ssrc:string; pt:number; timestamp:number; payload:string; }
export function parseRtp(output:string):RtpPacket[] {
 return output.split('\n').filter(Boolean).map(line=>{
  const [frame,time,src,dst,srcPort,dstPort,ssrc,pt,timestamp,payload]=line.split('\t');
  return {frame:Number(frame),time:Number(time),src,dst,srcPort,dstPort,ssrc,pt:Number(pt),timestamp:Number(timestamp),payload:(payload??'').replace(/:/g,'')};
 }).filter(p=>p.frame>0 && p.ssrc && Number.isFinite(p.time) && /^[a-f0-9]*$/i.test(p.payload));
}
export const streamKey=(p:RtpPacket)=>[p.src,p.srcPort,p.dst,p.dstPort,p.ssrc,p.pt].join('|');
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
