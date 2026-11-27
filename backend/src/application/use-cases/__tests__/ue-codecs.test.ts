import { createCipheriv, createHmac } from 'crypto';
import { amrFrames, evsFrames, speechFile, codecProblem } from '../ue-audio-codecs';
import { parseSdp, resolveCodec, imsSdesKeys, imsCodec } from '../ue-audio-sdp';
import { deriveSrtpKey, SrtpDecoder, rtpHeaderLength } from '../ue-srtp';

const master=Buffer.from('e1f97a0d3e018be0d64fa32c06de4139','hex'),salt=Buffer.from('0ec675ad498afeebb6960b3aabe6','hex');
const key=Buffer.concat([master,salt]).toString('base64');
function protect(seq:number,roc:number,tagLength=10){
 const header=Buffer.from('800000000000000012345678','hex');header.writeUInt16BE(seq,2);
 const iv=Buffer.alloc(16);deriveSrtpKey(master,salt,2,14).copy(iv);const index=Buffer.alloc(16);index.writeUInt32BE(0x12345678,4);index.writeUInt32BE(roc,8);index.writeUInt16BE(seq,12);for(let i=0;i<16;i++)iv[i]^=index[i];
 const payload=createCipheriv('aes-128-ctr',deriveSrtpKey(master,salt,0,16),iv).update(Buffer.from([255,0,128]));
 const packet=Buffer.concat([header,payload]),counter=Buffer.alloc(4);counter.writeUInt32BE(roc);
 const tag=createHmac('sha1',deriveSrtpKey(master,salt,1,20)).update(packet).update(counter).digest().subarray(0,tagLength);return Buffer.concat([packet,tag]);
}
describe('speech RTP formats',()=>{
 it.each([false,true])('converts AMR octet-aligned %s to storage frames',wide=>{
  const size=wide?17:12,payload=Buffer.concat([Buffer.from([0xf0,4]),Buffer.alloc(size)]);
  expect(amrFrames(payload,wide,true)).toEqual([Buffer.concat([Buffer.from([4]),Buffer.alloc(size)])]);
 });
 it('converts bandwidth-efficient AMR and preserves quality/multiple frames',()=>{
  // CMR=15, ToC F=0 FT=0 Q=1, then 95 zero speech bits.
  const payload=Buffer.alloc(14);payload[0]=0xf0;payload[1]=0x40;
  expect(amrFrames(payload,false,false)[0]).toEqual(Buffer.concat([Buffer.from([4]),Buffer.alloc(12)]));
  const multi=Buffer.concat([Buffer.from([0xf0,0x84,0x04]),Buffer.alloc(24)]);
  expect(amrFrames(multi,false,true)).toHaveLength(2);
 });
 it('rejects truncated and reserved AMR frame types and unsupported options',()=>{
  expect(()=>amrFrames(Buffer.from([0xf0,4]),false,true)).toThrow('Truncated');
  expect(()=>amrFrames(Buffer.from([0xf0,0x4c]),false,true)).toThrow('Reserved');
  expect(codecProblem({codec:'AMR',clock:8000,channels:1,fmtp:'interleaving=1',encrypted:false})).toMatch(/interleaving/);
 });
 it('converts compact EVS primary and header-full aggregation into EVS storage frames',()=>{
  expect(evsFrames(Buffer.alloc(33),false)[0]).toEqual(Buffer.concat([Buffer.from([4]),Buffer.alloc(33)]));
  expect(evsFrames(Buffer.concat([Buffer.from([0xff,0x44,0x03]),Buffer.alloc(33+24)]),true).map(f=>f[0])).toEqual([4,3]);
  expect(evsFrames(Buffer.from([0xff]),true)).toEqual([]);
  expect(speechFile('EVS',[]).toString('hex')).toBe('23214556535f4d43312e300a00000001');
 });
 it('converts compact EVS AMR-WB IO bit rotation and distinguishes the 56-bit SID case',()=>{
  const compact=Buffer.alloc(17);compact[16]=2; // last speech bit d(0), before one padding bit
  const frame=evsFrames(compact,false)[0];expect(frame[0]).toBe(0x30);expect(frame[1]).toBe(0x80);
  const sid=evsFrames(Buffer.concat([Buffer.from([0xff,0x39]),Buffer.alloc(5)]),false)[0];expect(sid[0]).toBe(0x39);expect(sid.length).toBe(6);
 });
 it('rejects invalid EVS ToC, truncation and nonzero trailing padding',()=>{
  expect(()=>evsFrames(Buffer.from([0x0d]),true)).toThrow('Reserved');
  expect(()=>evsFrames(Buffer.from([4]),true)).toThrow('Truncated');
  expect(()=>evsFrames(Buffer.concat([Buffer.from([12]),Buffer.alloc(6),Buffer.from([1])]),true)).toThrow('padding');
 });
});
describe('SDP mapping',()=>{
 it('scopes dynamic payloads to media endpoints and the setup frame',()=>{
  const xml='<pdml><packet><proto name="frame"><field name="frame.number" show="10"/></proto><proto name="sdp"><field name="sdp.connection_info" show="IN IP4 192.0.2.1"/><field name="sdp.media" show="audio 5000 RTP/AVP 96"/><field name="sdp.media_attr" show="rtpmap:96 AMR/8000"/><field name="sdp.media_attr" show="fmtp:96 octet-align=1"/><field name="sdp.media" show="audio 6000 RTP/SAVP 96"/><field name="sdp.media_attr" show="rtpmap:96 AMR-WB/16000"/></proto></packet></pdml>';
  const mappings=parseSdp(xml),p={frame:11,dst:'192.0.2.1',dstPort:'5000',pt:96};
  expect(resolveCodec(mappings,p)).toMatchObject({codec:'AMR',fmtp:'octet-align=1',encrypted:false});
  expect(resolveCodec(mappings,{...p,dstPort:'6000'})).toMatchObject({codec:'AMR-WB',encrypted:true});
  expect(resolveCodec(mappings,{...p,frame:9}).codec).toBe('PT 96');
  expect(resolveCodec(mappings,{...p,dst:'192.0.2.2'}).codec).toBe('PT 96');
 });
});
describe('SDES key discovery',()=>{
 it('finds the sender key in IMS SDP without exposing it in public codec metadata',()=>{
  const raw='INVITE sip:test@example.test SIP/2.0\r\n\r\nv=0\r\nc=IN IP4 192.0.2.1\r\nm=audio 5000 RTP/SAVP 96\r\na=rtpmap:96 AMR-WB/16000\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:'+key+'\r\n';
  const source={src:'192.0.2.1',srcPort:'5000',pt:96};
  expect(imsSdesKeys(raw,source)).toEqual([{key,suite:'AES_CM_128_HMAC_SHA1_80',roc:0}]);
  expect(imsSdesKeys(raw,{...source,src:'192.0.2.2'})).toEqual([]);
  expect(imsCodec(raw,{dst:'192.0.2.1',dstPort:'5000',pt:96})).toMatchObject({codec:'AMR-WB',encrypted:true});
  expect(JSON.stringify(imsCodec(raw,{dst:'192.0.2.1',dstPort:'5000',pt:96}))).not.toContain(key);
  expect(imsSdesKeys(raw.replace('inline:'+key,'inline:'+key+'|2^20|1:4'),source)).toEqual([]);
 });
});
describe('SRTP',()=>{
 it('matches RFC 3711 appendix B.3 session key vectors',()=>{
  expect(deriveSrtpKey(master,salt,0,16).toString('hex')).toBe('c61e7a93744f39ee10734afe3ff7a087');
  expect(deriveSrtpKey(master,salt,1,20).toString('hex')).toBe('cebe321f6ff7716b6fd4ab49af256a156d38baa4');
  expect(deriveSrtpKey(master,salt,2,14).toString('hex')).toBe('30cbbc08863d8c85d49db34a9ae1');
 });
 it.each([10,4])('authenticates, decrypts and tracks rollover with %s-byte tags',length=>{
  const decoder=new SrtpDecoder({key,suite:length===10?'AES_CM_128_HMAC_SHA1_80':'AES_CM_128_HMAC_SHA1_32'});
  expect(decoder.decode(protect(65535,0,length))).toEqual(Buffer.from([255,0,128]));
  expect(decoder.decode(protect(0,1,length))).toEqual(Buffer.from([255,0,128]));
  expect(decoder.decode(protect(65534,0,length))).toEqual(Buffer.from([255,0,128]));decoder.destroy();
 });
 it('refuses altered packets, incorrect keys and invalid RTP extensions',()=>{
  const decoder=new SrtpDecoder({key,suite:'AES_CM_128_HMAC_SHA1_80'}),packet=protect(1,0);packet[12]^=1;
  expect(()=>decoder.decode(packet)).toThrow('authentication failed');decoder.destroy();
  expect(()=>new SrtpDecoder({key:'invalid',suite:'AES_CM_128_HMAC_SHA1_80'})).toThrow('30-byte');
  expect(()=>rtpHeaderLength(Buffer.from('900000000000000012345678','hex'))).toThrow('Truncated');
 });
});
