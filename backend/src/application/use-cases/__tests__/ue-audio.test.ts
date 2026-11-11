import { decodeG711, parseRtp, audioWindow, streamKey } from '../ue-audio';
import { UeDiagnosticsUseCase } from '../ue-diagnostics';
describe('UE audio',()=>{
 it('decodes standard G.711 zero and maximum-amplitude values',()=>{
  expect([255,127,0,128].map(b=>decodeG711(b,0))).toEqual([0,0,-32124,32124]);
  expect([213,85,170,42].map(b=>decodeG711(b,8))).toEqual([8,-8,32256,-32256]);
 });
 it('separates streams, suppresses duplicate RTP timestamps and preserves loss as silence',()=>{
  const packets=parseRtp('1\t100\ta\tb\t1\t2\t0x123\t0\t100\tff:ff\n2\t100.1\ta\tb\t1\t2\t0x123\t0\t104\t00:80\n3\t100.2\ta\tb\t1\t2\t0x123\t0\t104\t00:80\n4\t100.3\ta\tb\t1\t2\t0x124\t96\t100\tff');
  const window=audioWindow(packets,'',0);expect(window.streams).toHaveLength(2);expect(window.streams[1].supported).toBe(false);
  const pcm=Buffer.from(window.pcm,'base64');expect(pcm.length).toBe(12);expect(pcm.readInt16LE(8)).toBe(-32124);expect(window.cursor).toBe(3);
  expect(audioWindow(packets,streamKey(packets[0]),3).pcm).toBe('');
  expect(audioWindow(packets,streamKey(packets[3]),0).pcm).toBe('');
 });
 it('bounds the live window and skips older audio',()=>{
  const p=parseRtp('1\t1\ta\tb\t1\t2\t123\t8\t0\td5\n2\t20\ta\tb\t1\t2\t123\t8\t100\td5');
  expect(audioWindow(p,'',0)).toMatchObject({skipped:true,seconds:1/8000,cursor:2});
 });
 it('installs only missing tools and shares concurrent installer requests',async()=>{
  let installed=false;
  const executor={executeCommand:jest.fn().mockResolvedValue({exitCode:0}),executeLocalCommand:jest.fn().mockImplementation(async(command:string,args:string[])=>{
   if(command==='tshark')return {exitCode:installed?0:127};
   if(args.includes('install'))installed=true;return {exitCode:0};
  })};
  const uc=new UeDiagnosticsUseCase({} as never,{} as never,{} as never,executor as never);
  const results=await Promise.all([uc.installDependencies(),uc.installDependencies()]);expect(results.every((r:any)=>r.ready)).toBe(true);
  expect(executor.executeLocalCommand.mock.calls.filter(c=>c[0]==='env')).toHaveLength(2);
 });
 it('does not invoke package installation when the host and decoder already exist',async()=>{
  const executor={executeLocalCommand:jest.fn().mockResolvedValue({exitCode:0}),executeCommand:jest.fn().mockResolvedValue({exitCode:0})};
  const uc=new UeDiagnosticsUseCase({} as never,{} as never,{} as never,executor as never);
  await expect(uc.installDependencies()).resolves.toMatchObject({ready:true});
  expect(executor.executeCommand.mock.calls.every(c=>c[0]==='dumpcap')).toBe(true);
  expect(executor.executeLocalCommand.mock.calls.every(c=>c[0]==='tshark')).toBe(true);
 });
});
