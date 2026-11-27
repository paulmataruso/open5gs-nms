import type { Db } from 'mongodb';
import { imsSdesKeys, imsCodec } from './ue-audio-sdp';
import type { RtpPacket } from './ue-audio';
import type { CodecDescription } from './ue-audio-codecs';
import type { SrtpInput } from './ue-srtp';

export type ImsAudioLookup=(packet:RtpPacket)=>Promise<{description?:CodecDescription;keys:SrtpInput[]}>;
export function createImsAudioLookup(db:Db):ImsAudioLookup {
 return async packet=>{
  // Only existing IMS traces are read; tracing is never enabled implicitly.
  // Do not log raw SDP: it may contain SDES material.
  const messages=await db.collection('nms_sip_trace').find({
   timestamp:{$gte:new Date(packet.time*1000-4*3600000),$lte:new Date(packet.time*1000+1000)},
   raw:{$regex:'(?:^|\\n)m=audio'},
  },{projection:{raw:1}}).sort({timestamp:-1}).limit(100).toArray();
  let description:CodecDescription|undefined;const keys:SrtpInput[]=[];
  for(const message of messages){
   if(typeof message.raw!=='string' || message.raw.length>262144)continue;
   description??=imsCodec(message.raw,packet);
   keys.push(...imsSdesKeys(message.raw,packet));
   if(keys.length>=8 && description)break;
  }
  return {description,keys:keys.slice(0,8)};
 };
}
