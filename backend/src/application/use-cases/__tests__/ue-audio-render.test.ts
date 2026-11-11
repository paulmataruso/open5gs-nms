jest.mock('../ue-codec-runtime',()=>({decodeSpeech:jest.fn(async(codec:string)=>({pcm:Buffer.alloc(codec==='EVS'?3840:codec==='AMR-WB'?1280:640),sampleRate:codec==='EVS'?48000:codec==='AMR-WB'?16000:8000}))}));
import { parseRtp, renderAudio } from '../ue-audio';
import { decodeSpeech } from '../ue-codec-runtime';
describe('audio rendering',()=>{
 it('never treats unknown dynamic payloads or encrypted G.711 as plaintext',async()=>{
  const dynamic=parseRtp('1\t1\ta\tb\t1\t2\t1\t96\t0\tff');
  expect(await renderAudio(dynamic,'',0)).toMatchObject({pcm:'',notice:expect.stringContaining('Unknown codec')});
  const encrypted=parseRtp('1\t1\ta\tb\t1\t2\t1\t0\t0\tff\t800000000000000000000001ff\tff');
  expect(await renderAudio(encrypted,'',0)).toMatchObject({pcm:'',notice:expect.stringContaining('SRTP requires')});
 });
 it('honors dynamic PCMA mapping and suppresses already delivered packets',async()=>{
  const p=parseRtp('1\t1\ta\tb\t1\t2\t1\t96\t0\td5');
  const first=await renderAudio(p,'',0,{codec:'PCMA'});expect(Buffer.from(first.pcm,'base64').readInt16LE()).toBe(8);
  expect((await renderAudio(p,'',1,{codec:'PCMA'})).pcm).toBe('');
 });
 it.each(['AMR','AMR-WB','EVS'] as const)('uses the %s decoder and its sample rate',async(codec)=>{
  const bytes=codec==='EVS'?Buffer.alloc(33):Buffer.concat([Buffer.from([0xf0,4]),Buffer.alloc(codec==='AMR'?12:17)]);
  const p=parseRtp('1\t1\ta\tb\t1\t2\t1\t96\t0\t'+bytes.toString('hex'));
  const options={codec,octetAlign:'1' as const};
  const result=await renderAudio(p,'',0,options,{amr:true,amrWb:true,evs:true});
  expect(result.sampleRate).toBe(codec==='EVS'?48000:codec==='AMR-WB'?16000:8000);expect(result.pcm).not.toBe('');expect(decodeSpeech).toHaveBeenCalledWith(codec,expect.any(Buffer));
 });
 it('reports unavailable tools and refuses unsupported negotiated packetization',async()=>{
  const p=parseRtp('1\t1\ta\tb\t1\t2\t1\t96\t0\t00');
  expect(await renderAudio(p,'',0,{codec:'AMR'})).toMatchObject({pcm:'',notice:'Install the AMR decoder'});
  p[0].description={codec:'AMR',clock:8000,channels:1,fmtp:'crc=1',encrypted:false};
  expect((await renderAudio(p,'',0,{}, {amr:true,amrWb:true,evs:true})).notice).toContain('CRC');
 });
});
