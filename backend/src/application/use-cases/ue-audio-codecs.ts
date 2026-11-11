// RFC 4867 and 3GPP TS 26.445 Annex A. Only mono, non-interleaved payloads.
export type SpeechCodec = 'PCMU' | 'PCMA' | 'AMR' | 'AMR-WB' | 'EVS';
export interface CodecDescription { codec:string; clock:number; channels:number; fmtp:string; encrypted:boolean; }
export const AMR_BITS=[95,103,118,134,148,159,204,244,39,-1,-1,-1,-1,-1,-1,0];
export const WB_BITS=[132,177,253,285,317,365,397,461,477,40,-1,-1,-1,-1,0,0];
const EVS_BITS=[56,144,160,192,264,328,488,640,960,1280,1920,2560,48,-1,0,0];
export const parameter=(fmtp:string,name:string)=>new RegExp('(?:^|;)\\s*'+name+'\\s*=\\s*([^;]+)','i').exec(fmtp)?.[1].trim();
export function codecProblem(d:CodecDescription):string|undefined {
 if(d.channels!==1)return 'Multi-channel audio is not supported';
 if(!['PCMU','PCMA','AMR','AMR-WB','EVS'].includes(d.codec))return 'Unknown codec: capture SIP/SDP or select the codec manually';
 if(d.clock!==({PCMU:8000,PCMA:8000,AMR:8000,'AMR-WB':16000,EVS:16000} as Record<string,number>)[d.codec])return 'Unexpected RTP clock rate for this codec';
 if(['AMR','AMR-WB'].includes(d.codec) && ['interleaving','robust-sorting','crc'].some(p=>Number(parameter(d.fmtp,p)||0)!==0))return 'AMR interleaving, robust sorting and CRC payloads are not supported';
 return undefined;
}
class Bits {
 at=0;
 constructor(readonly data:Buffer){}
 take(n:number):number {if(this.at+n>this.data.length*8)throw new Error('Truncated speech payload');let v=0;for(let i=0;i<n;i++,this.at++)v=(v<<1)|((this.data[this.at>>3]>>(7-(this.at&7)))&1);return v;}
 bytes(n:number):Buffer {const out=Buffer.alloc(Math.ceil(n/8));for(let i=0;i<n;i++)out[i>>3]|=this.take(1)<<(7-(i&7));return out;}
}
export function amrFrames(data:Buffer,wide:boolean,octetAligned:boolean):Buffer[] {
 const bits=new Bits(data),table=wide?WB_BITS:AMR_BITS;
 bits.take(4);if(octetAligned)bits.take(4); // Codec mode request, then reserved bits.
 const toc:Array<{ft:number;q:number}>=[];let follows:number;
 do {follows=bits.take(1);const ft=bits.take(4),q=bits.take(1);if(table[ft]<0)throw new Error('Reserved AMR frame type');if(octetAligned)bits.take(2);toc.push({ft,q});if(toc.length>100)throw new Error('Too many AMR frames in a packet');}while(follows);
 const frames=toc.map(({ft,q})=>{const speech=bits.bytes(table[ft]);if(octetAligned && table[ft]%8)bits.take(8-table[ft]%8);return Buffer.concat([Buffer.from([(ft<<3)|(q<<2)]),speech]);});
 if(data.length*8-bits.at>7)throw new Error('Unexpected trailing AMR data');
 return frames;
}
export function evsFrames(data:Buffer,hfOnly:boolean):Buffer[] {
 if(!data.length)throw new Error('Empty EVS payload');
 // Default compact sizes uniquely identify primary and AMR-WB IO modes.
 if(!hfOnly){
  const primary=EVS_BITS.findIndex((n,i)=>i<13 && n===data.length*8);
  // 56 bits with H=1 is the special header-full AMR-WB SID case.
  if(primary>=0 && !(data.length===7 && (data[0]&128)))return [Buffer.concat([Buffer.from([primary]),data])];
  const io=WB_BITS.findIndex((n,i)=>i<9 && Math.ceil((n+3)/8)===data.length);
  if(io>=0){const b=new Bits(data);b.take(3);const rest=b.bytes(WB_BITS[io]-1),out=Buffer.alloc(Math.ceil(WB_BITS[io]/8));const d0=b.take(1);out[0]=d0<<7;for(let i=0;i<WB_BITS[io]-1;i++)out[(i+1)>>3]|=((rest[i>>3]>>(7-(i&7)))&1)<<(7-((i+1)&7));return [Buffer.concat([Buffer.from([0x30|io]),out])];}
 }
 let at=(data[0]&128)?1:0;const headers:number[]=[];let h:number;
 // A CMR-only packet contains no speech.
 if(at===data.length)return [];
 do{if(at>=data.length)throw new Error('Truncated EVS ToC');h=data[at++];if(h&128)throw new Error('Invalid EVS ToC');const ft=h&15;if((h&32?WB_BITS:EVS_BITS)[ft]<0 || (!(h&32)&&(h&16)))throw new Error('Reserved EVS frame type');headers.push(h&63);if(headers.length>100)throw new Error('Too many EVS frames');}while(h&64);
 const frames=headers.map(header=>{const count=Math.ceil(((header&32?WB_BITS:EVS_BITS)[header&15])/8);if(at+count>data.length)throw new Error('Truncated EVS speech data');const frame=Buffer.concat([Buffer.from([header]),data.subarray(at,at+count)]);at+=count;return frame;});
 if(data.subarray(at).some(byte=>byte!==0))throw new Error('Invalid EVS padding');
 return frames;
}
export function speechFile(codec:SpeechCodec,frames:Buffer[]):Buffer {
 const header=codec==='AMR'?Buffer.from('#!AMR\n'):codec==='AMR-WB'?Buffer.from('#!AMR-WB\n'):Buffer.concat([Buffer.from('#!EVS_MC1.0\n'),Buffer.from([0,0,0,1])]);
 return Buffer.concat([header,...frames]);
}
