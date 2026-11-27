import { PcapUseCase } from '../pcap';
import { captureAddresses, parseDiagnosticPackets, diagnosticSummary, UeDiagnosticsUseCase } from '../ue-diagnostics';
describe('UE Diagnostics',()=>{
 it.each([false,true])('preserves byte offset zero with a tshark summary: %s',async(summary)=>{
  const dump='0000  45 00 00 54   E..T\n0010  ac 14 18 0c   ....\n';
  const executor={executeLocalCommand:jest.fn().mockImplementation((_command:string,args:string[])=>Promise.resolve({exitCode:0,stderr:'',stdout:args.includes('pdml')?'<pdml><packet></packet></pdml>':(summary?'Packet summary\n':'')+dump}))};
  const uc=new PcapUseCase(executor as never,{} as never,{} as never);
  expect((await uc.getPacketDetail('1794414497121',69)).hex).toBe(dump.trim());
 });
 it('requires explicit valid IP targets and refuses empty/unscoped captures',()=>{
  expect(()=>captureAddresses([])).toThrow();
  expect(()=>captureAddresses(['10.0.0.1; reboot'])).toThrow();
  expect(()=>captureAddresses(['example.com'])).toThrow();
  expect(captureAddresses(['10.0.0.1','2001:db8::1','10.0.0.1'])).toEqual(['10.0.0.1','2001:db8::1']);
  expect(captureAddresses(['2001:0DB8:0:0::1','2001:db8::1'])).toEqual(['2001:db8::1']);
 });
 it('decodes IPv4/IPv6 endpoints, ports and directional 5-second rates',()=>{
  const text='1\t99\t10.0.0.1\t192.0.2.1\tTCP\t100\t5000\t443\t\t\tSYN\n'
   +'2\t100\t192.0.2.1\t10.0.0.1\tTCP\t200\t443\t5000\t\t\tACK\n'
   +'3\t100\t2001:db8::1\t2001:db8::2\tUDP\t50\t\t\t5000\t53\tDNS';
  const packets=parseDiagnosticPackets(text,['10.0.0.1','2001:db8::1']);
  expect(packets.map(p=>p.direction)).toEqual(['tx','rx','tx']);
  expect(packets[2].dstPort).toBe('53');
  const stats=diagnosticSummary(packets,true,101);
  expect(stats.totalPackets).toBe(3);expect(stats.totalBytes).toBe(350);
  expect(stats.txBps).toBe(240);expect(stats.rxBps).toBe(320);expect(stats.flows).toHaveLength(3);
  expect(diagnosticSummary(packets,true,110).flows).toHaveLength(0);
  expect(diagnosticSummary(packets,false,110).flows).toHaveLength(3);
 });
 it('limits packet display while keeping complete counters',()=>{
  const packets=Array.from({length:600},(_,i)=>({frameNumber:i+1,timeEpoch:100,src:'a',dst:'b',protocol:'TCP',srcPort:'1',dstPort:'2',length:60,info:'',direction:'tx' as const}));
  const summary=diagnosticSummary(packets,true,101);
  expect(summary.totalPackets).toBe(600);expect(summary.packets).toHaveLength(500);expect(summary.packets[0].frameNumber).toBe(600);expect(summary.truncated).toBe(true);
 });
 it('binds selected UE captures to server-resolved session addresses and limits',async()=>{
  const pcap={listInterfaces:jest.fn().mockResolvedValue([{name:'ogstun'}]),listCaptures:jest.fn().mockResolvedValue([]),start:jest.fn().mockResolvedValue({id:'1'})};
  const active={getActive4GUEs:jest.fn().mockResolvedValue([{imsi:'001010000000001',ip:'10.0.0.1',sessions:[{apn:'data',ip:'10.0.0.1'}]}]),getActive5GUEs:jest.fn().mockResolvedValue([])};
  const repo={findAllFull:jest.fn().mockResolvedValue([])};
  const executor={executeLocalCommand:jest.fn().mockResolvedValue({exitCode:0,stdout:'[{"dev":"ogstun"}]'})};
  const uc=new UeDiagnosticsUseCase(pcap as never,active as never,repo as never,executor as never);
  await expect(uc.start({imsi:'001010000000001',addresses:['192.0.2.100']})).rejects.toThrow('does not belong');
  await expect(uc.start({addresses:['10.0.0.1'],durationSeconds:0})).rejects.toThrow('Duration');
  await uc.start({imsi:'001010000000001'});
  expect(pcap.start).toHaveBeenCalledWith(expect.objectContaining({interfaces:['ogstun'],scope:{mode:'custom',customBpf:'host 10.0.0.1'},autostopSeconds:60,autostopFilesizeKb:10240,ueDiagnostics:{imsi:'001010000000001',addresses:['10.0.0.1']}}));
 });
 it('passes display filters as arguments and tolerates only an incomplete live tail',async()=>{
  const capture={id:'1',status:'running',ueDiagnostics:{addresses:['10.0.0.1']}};
  const pcap={listCaptures:jest.fn().mockResolvedValue([capture]),getDownloadPath:jest.fn().mockResolvedValue('/safe/1.pcapng')};
  const exec={executeLocalCommand:jest.fn().mockResolvedValue({exitCode:2,stdout:'1\t100\t10.0.0.1\t192.0.2.1\tUDP\t50\t\t\t1\t2\tdata',stderr:'The file appears to have been cut short in the middle of a packet.'})};
  const uc=new UeDiagnosticsUseCase(pcap as never,{} as never,{} as never,exec as never);
  await expect(uc.snapshot('1','udp.port == 2')).resolves.toMatchObject({partial:true,totalPackets:1});
  expect(exec.executeLocalCommand.mock.calls[0][1]).toEqual(expect.arrayContaining(['-Y','udp.port == 2']));
  exec.executeLocalCommand.mockResolvedValue({exitCode:2,stdout:'',stderr:'Invalid display filter'});
  await expect(uc.snapshot('1','bad filter')).rejects.toThrow('Invalid display filter');
 });
 it('captures every routed interface for a UE with multiple APNs',async()=>{
  const pcap={listInterfaces:jest.fn().mockResolvedValue([{name:'ogstun'},{name:'ogstun2'}]),listCaptures:jest.fn().mockResolvedValue([]),start:jest.fn().mockResolvedValue({id:'2'})};
  const active={getActive4GUEs:jest.fn().mockResolvedValue([{imsi:'001010000000001',sessions:[{apn:'data',ip:'10.0.0.1'},{apn:'ims',ip:'10.1.0.1'}]}]),getActive5GUEs:jest.fn().mockResolvedValue([])};
  const executor={executeLocalCommand:jest.fn().mockImplementation((_command:string,args:string[])=>Promise.resolve({stdout:JSON.stringify([{dev:args[3]==='10.0.0.1'?'ogstun':'ogstun2'}])}))};
  const uc=new UeDiagnosticsUseCase(pcap as never,active as never,{findAllFull:async()=>[]} as never,executor as never);
  await uc.start({imsi:'001010000000001'});
  expect(pcap.start).toHaveBeenCalledWith(expect.objectContaining({interfaces:['ogstun','ogstun2'],scope:{mode:'custom',customBpf:'host 10.0.0.1 or host 10.1.0.1'}}));
 });

});
