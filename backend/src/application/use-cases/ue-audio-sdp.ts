import { XMLParser } from 'fast-xml-parser';
import { isIP } from 'net';
import type { SrtpInput } from './ue-srtp';
import type { CodecDescription } from './ue-audio-codecs';

const canonical=(ip:string)=>isIP(ip)===6?new URL("http://["+ip+"]/").hostname.slice(1,-1).toLowerCase():ip;
interface Mapping { frame:number; address:string;port:string;pt:number;description:CodecDescription; sdes?:SrtpInput[]; }
const array=(value:any):any[]=>value===undefined?[]:Array.isArray(value)?value:[value];
function nodes(value:any,name:string):any[]{
 if(!value || typeof value!=='object')return [];
 return [...(value['@_name']===name?[value]:[]),...Object.values(value).flatMap(v=>array(v).flatMap(child=>nodes(child,name)))];
}
export function parseSdp(pdml:string,includeKeys=false):Mapping[]{
 const document=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',processEntities:false}).parse(pdml);
 const mappings:Mapping[]=[];
 for(const packet of array(document?.pdml?.packet)){
  const frame=Number(nodes(packet,'frame.number')[0]?.['@_show']);
  for(const sdp of nodes(packet,'sdp')){
   let sessionAddress='';let media:{address:string;port:string;pts:number[];encrypted:boolean;audio:boolean;attrs:string[]}|undefined;
   const finish=()=>{
    if(!media?.audio || !isIP(media.address) || media.port==='0')return;
    for(const pt of media.pts){
     const attr=media.attrs.find(a=>new RegExp('^rtpmap:'+pt+'\\s','i').test(a));
     const match=attr?.match(/^rtpmap:\d+\s+([^/\s]+)\/(\d+)(?:\/(\d+))?/i);
     const codec=match?.[1].toUpperCase() || (pt===0?'PCMU':pt===8?'PCMA':'PT '+pt);
     const fmtp=media.attrs.find(a=>new RegExp('^fmtp:'+pt+'\\s','i').test(a))?.replace(/^fmtp:\d+\s+/i,'')??'';
     mappings.push({frame,address:canonical(media.address),port:media.port,pt,description:{codec,clock:Number(match?.[2]??8000),channels:Number(match?.[3]??1),fmtp,encrypted:media.encrypted},...(includeKeys?{sdes:media.attrs.map(sdesAttribute).filter((s):s is SrtpInput=>!!s)}:{})});
    }
   };
   for(const field of array(sdp.field)){
    const name=field['@_name'],show=String(field['@_show']??'');
    if(name==='sdp.connection_info'){const address=show.split(/\s+/)[2]?.split('/')[0]??'';if(media)media.address=address;else sessionAddress=address;}
    if(name==='sdp.media'){finish();const [type,port,proto,...formats]=show.split(/\s+/);media={address:sessionAddress,port:port?.split('/')[0],audio:type==='audio',encrypted:/SAVP/i.test(proto??''),pts:formats.map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<=127),attrs:[]};}
    if(name==='sdp.media_attr' && media)media.attrs.push(show);
   }
   finish();
  }
 }
 return mappings;
}
export function resolveCodec(mappings:Mapping[],packet:{frame:number;dst:string;dstPort:string;pt:number}):CodecDescription {
 const matched=mappings.filter(m=>m.frame<=packet.frame && m.address===canonical(packet.dst) && m.port===packet.dstPort && m.pt===packet.pt).sort((a,b)=>b.frame-a.frame)[0];
 return matched?.description??{codec:packet.pt===0?'PCMU':packet.pt===8?'PCMA':'PT '+packet.pt,clock:8000,channels:1,fmtp:'',encrypted:false};
}

// SDES keys describe the media sender: match the RTP source, not destination.
function sdesAttribute(attribute:string):SrtpInput|undefined {
 const match=/^crypto:\d+\s+(AES_CM_128_HMAC_SHA1_(?:80|32))\s+inline:([A-Za-z0-9+/]{40})(?:\|([^\s]+))?\s*$/.exec(attribute);
 if(!match || match[3]?.includes(':') || match[3]?.includes('|'))return undefined; // no MKI/session parameters
 return {suite:match[1] as SrtpInput['suite'],key:match[2],roc:0};
}
export function sdesKeys(pdml:string,packet:{frame:number;src:string;srcPort:string;pt:number}):SrtpInput[] {
 return parseSdp(pdml,true).filter(m=>m.frame<=packet.frame && m.address===canonical(packet.src) && m.port===packet.srcPort && m.pt===packet.pt).sort((a,b)=>b.frame-a.frame).flatMap(m=>m.sdes??[]).slice(0,8);
}
function imsPdml(raw:string):string {
 const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const fields=raw.split(/\r?\n/).flatMap(line=>{const type=line.slice(0,2),name=type==='m='?'sdp.media':type==='c='?'sdp.connection_info':type==='a='?'sdp.media_attr':'';return name?['<field name="'+name+'" show="'+escape(line.slice(2))+'"/>']:[];}).join('');
 return '<pdml><packet><proto name="frame"><field name="frame.number" show="1"/></proto><proto name="sdp">'+fields+'</proto></packet></pdml>';
}
export function imsSdesKeys(raw:string,packet:{src:string;srcPort:string;pt:number}):SrtpInput[]{return sdesKeys(imsPdml(raw),{...packet,frame:1});}
export function imsCodec(raw:string,packet:{dst:string;dstPort:string;pt:number}):CodecDescription|undefined {
 const mapping=parseSdp(imsPdml(raw)).find(m=>m.address===canonical(packet.dst) && m.port===packet.dstPort && m.pt===packet.pt);
 return mapping?.description;
}
