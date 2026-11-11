import { createCipheriv, createHmac, timingSafeEqual } from 'crypto';

export interface SrtpInput { key:string; suite:'AES_CM_128_HMAC_SHA1_80'|'AES_CM_128_HMAC_SHA1_32'; roc?:number; }
export function deriveSrtpKey(master:Buffer,salt:Buffer,label:number,length:number):Buffer {
 const iv=Buffer.alloc(16);salt.copy(iv);iv[7]^=label;
 const aes=createCipheriv('aes-128-ctr',master,iv);return aes.update(Buffer.alloc(length));
}
export function rtpHeaderLength(packet:Buffer):number {
 if(packet.length<12 || packet[0]>>6!==2)throw new Error('Invalid RTP header');
 let length=12+4*(packet[0]&15);
 if(packet[0]&16){if(length+4>packet.length)throw new Error('Truncated RTP extension');length+=4+packet.readUInt16BE(length+2)*4;}
 if(length>packet.length)throw new Error('Truncated RTP header');return length;
}
// RFC 3711 AES-CM / HMAC-SHA1, KDR=0, no MKI. Keys stay in this request.
export class SrtpDecoder {
 private encryption:Buffer;private authentication:Buffer;private salt:Buffer;
 private states=new Map<number,{roc:number;sequence:number}>();
 private initialRoc:number;private tagLength:number;
 constructor(input:SrtpInput){
  if(!input || !['AES_CM_128_HMAC_SHA1_80','AES_CM_128_HMAC_SHA1_32'].includes(input.suite))throw new Error('Unsupported SRTP suite');
  if(!/^[A-Za-z0-9+/]{40}$/.test(input.key))throw new Error('SRTP requires the base64 30-byte master key and salt');
  const material=Buffer.from(input.key,'base64');if(material.length!==30)throw new Error('Invalid SRTP master key length');
  const master=material.subarray(0,16),salt=material.subarray(16);
  this.encryption=deriveSrtpKey(master,salt,0,16);this.authentication=deriveSrtpKey(master,salt,1,20);this.salt=deriveSrtpKey(master,salt,2,14);
  this.initialRoc=Number(input.roc??0);if(!Number.isInteger(this.initialRoc)||this.initialRoc<0||this.initialRoc>0xffffffff)throw new Error('Invalid SRTP rollover counter');
  this.tagLength=input.suite.endsWith('_80')?10:4;material.fill(0);
 }
 decode(packet:Buffer):Buffer {
  const header=rtpHeaderLength(packet),end=packet.length-this.tagLength;
  if(end<header)throw new Error('Truncated SRTP authentication tag');
  const sequence=packet.readUInt16BE(2),ssrc=packet.readUInt32BE(8),state=this.states.get(ssrc);
  let roc=state?.roc??this.initialRoc;
  if(state){if(state.sequence<32768 && sequence-state.sequence>32768)roc=(roc-1)>>>0;else if(state.sequence>=32768 && state.sequence-32768>sequence)roc=(roc+1)>>>0;}
  const counter=Buffer.alloc(4);counter.writeUInt32BE(roc);
  const expected=createHmac('sha1',this.authentication).update(packet.subarray(0,end)).update(counter).digest().subarray(0,this.tagLength);
  if(!timingSafeEqual(expected,packet.subarray(end)))throw new Error('SRTP authentication failed: check the stream key, suite and initial rollover counter (no audio was decoded)');
  if(!state || roc>state.roc || (roc===state.roc && sequence>state.sequence))this.states.set(ssrc,{roc,sequence});
  const iv=Buffer.alloc(16);this.salt.copy(iv);const index=Buffer.alloc(16);index.writeUInt32BE(ssrc,4);index.writeUInt32BE(roc,8);index.writeUInt16BE(sequence,12);for(let i=0;i<16;i++)iv[i]^=index[i];
  const aes=createCipheriv('aes-128-ctr',this.encryption,iv);let payload=aes.update(packet.subarray(header,end));
  if(packet[0]&32){const padding=payload[payload.length-1];if(!padding || padding>payload.length)throw new Error('Invalid SRTP padding');payload=payload.subarray(0,-padding);}
  return payload;
 }
 destroy(){this.encryption.fill(0);this.authentication.fill(0);this.salt.fill(0);this.states.clear();}
}
