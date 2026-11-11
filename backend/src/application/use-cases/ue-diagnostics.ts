import { SrtpDecoder } from './ue-srtp';
import type { ImsAudioLookup } from './ue-ims-audio';
import { renderAudio, parseRtp, type AudioOptions, type RtpPacket, streamKey } from './ue-audio';
import { parseSdp, resolveCodec, sdesKeys } from './ue-audio-sdp';
import { codecTools, readAudioCapture } from './ue-codec-runtime';
import { isIP } from 'net';
import type { IHostExecutor } from '../../domain/interfaces/host-executor';
import type { ISubscriberRepository } from '../../domain/interfaces/subscriber-repository';
import type { ActiveSessionsUseCase } from './active-sessions';
import { PcapUseCase, PcapManifest } from './pcap';

export interface DiagnosticPacket {
  frameNumber: number; timeEpoch: number; src: string; dst: string; protocol: string;
  srcPort: string; dstPort: string; length: number; info: string; direction: 'tx' | 'rx' | 'other';
}
function canonicalIp(ip:string):string {
  return isIP(ip)===6 ? new URL('http://['+ip+']/').hostname.slice(1,-1).toLowerCase() : ip;
}
export function captureAddresses(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) throw new Error('Select between 1 and 8 UE IP addresses');
  const addresses = [...new Set(input.map(value => String(value).trim()))];
  if (addresses.some(ip => !isIP(ip))) throw new Error('Every target must be a valid IPv4 or IPv6 address');
  return [...new Set(addresses.map(canonicalIp))];
}
export function parseDiagnosticPackets(output: string, addresses: string[]): DiagnosticPacket[] {
  const targets = new Set(addresses.map(canonicalIp));
  return output.split('\n').filter(Boolean).map(line => {
    const [number,time,src,dst,protocol,length,tcpSrc,tcpDst,udpSrc,udpDst,...info] = line.split('\t');
    return { frameNumber: Number(number), timeEpoch: Number(time), src:src ?? '', dst:dst ?? '',
      protocol:protocol ?? '', length:Number(length) || 0, srcPort:tcpSrc || udpSrc || '', dstPort:tcpDst || udpDst || '',
      info:info.join('\t'), direction:targets.has(canonicalIp(src ?? '')) ? 'tx' as const : targets.has(canonicalIp(dst ?? '')) ? 'rx' as const : 'other' as const };
  }).filter(packet => packet.frameNumber > 0 && Number.isFinite(packet.timeEpoch));
}
export function diagnosticSummary(packets: DiagnosticPacket[], running: boolean, now = Date.now() / 1000) {
  const end = running ? now : packets[packets.length - 1]?.timeEpoch ?? now;
  const windowSeconds = 5;
  const recent = packets.filter(packet => packet.timeEpoch >= end - windowSeconds && packet.timeEpoch <= end + 1);
  const flows = new Map<string, {src:string;dst:string;srcPort:string;dstPort:string;protocol:string;direction:string;packets:number;bytes:number;bps:number;pps:number}>();
  for (const packet of recent) {
    const key = JSON.stringify([packet.src,packet.dst,packet.srcPort,packet.dstPort,packet.protocol]);
    const flow = flows.get(key) ?? {src:packet.src,dst:packet.dst,srcPort:packet.srcPort,dstPort:packet.dstPort,protocol:packet.protocol,direction:packet.direction,packets:0,bytes:0,bps:0,pps:0};
    flow.packets++; flow.bytes += packet.length; flow.bps = flow.bytes * 8 / windowSeconds; flow.pps = flow.packets / windowSeconds;
    flows.set(key,flow);
  }
  return { totalPackets:packets.length,totalBytes:packets.reduce((sum,p)=>sum+p.length,0),windowSeconds,
    txBps:recent.filter(p=>p.direction==='tx').reduce((sum,p)=>sum+p.length*8/windowSeconds,0),
    rxBps:recent.filter(p=>p.direction==='rx').reduce((sum,p)=>sum+p.length*8/windowSeconds,0),
    flows:[...flows.values()].sort((a,b)=>b.bytes-a.bytes).slice(0,100),
    packets:packets.slice(-500).reverse(),truncated:packets.length>500 };
}

export class UeDiagnosticsUseCase {
  private starting = false;
  private audioCaptures=new Map<string,{at:number;promise:Promise<RtpPacket[]>}>();
  private installing:Promise<unknown>|undefined;
  private snapshots = new Map<string, {at:number; promise:Promise<unknown>}>();
  constructor(private pcap:PcapUseCase,private active:ActiveSessionsUseCase,
    private subscribers:ISubscriberRepository,private executor:IHostExecutor,private imsAudio?:ImsAudioLookup) {}
  async dependencies(force=false) {
    const check=async(host:boolean,command:string)=>{try{const r=await (host?this.executor.executeCommand(command,['--version'],5000,{expectedFailure:true}):this.executor.executeLocalCommand(command,['--version'],5000));return r.exitCode===0;}catch{return false;}};
    const [tshark,dumpcap,codecs]=await Promise.all([check(false,'tshark'),check(true,'dumpcap'),codecTools(force)]);
    return {tshark,dumpcap,...codecs,ready:tshark&&dumpcap&&codecs.amr&&codecs.amrWb&&codecs.evs,audioCodecs:['PCMU / G.711 μ-law','PCMA / G.711 A-law',...(codecs.amr?['AMR']:[]),...(codecs.amrWb?['AMR-WB']:[]),...(codecs.evs?['EVS primary / AMR-WB IO']:[])],srtpSuites:['AES_CM_128_HMAC_SHA1_80','AES_CM_128_HMAC_SHA1_32'],installing:!!this.installing};
  }
  async installDependencies() {
    if(this.installing)return this.installing;
    this.installing=(async()=>{
      const status=await this.dependencies();
      const install=async(host:boolean)=>{
        const run=(args:string[],timeout:number)=>host?this.executor.executeCommand('env',['DEBIAN_FRONTEND=noninteractive','apt-get',...args],timeout):this.executor.executeLocalCommand('env',['DEBIAN_FRONTEND=noninteractive','apt-get',...args],timeout);
        for(const args of [['update'],['install','-y','--no-install-recommends','tshark']]){const r=await run(args,180000);if(r.exitCode!==0)throw new Error('Dependency installation failed: '+(r.stderr||r.stdout).slice(-1500));}
      };
      if(!status.tshark)await install(false);
      if(!status.dumpcap)await install(true);
      if(!status.amr || !status.amrWb || !status.evs){const codecs=await this.executor.executeLocalCommand('python3',['tools/ue-codec-install.py'],600000);if(codecs.exitCode!==0)throw new Error('Audio codec installation failed: '+(codecs.stderr||codecs.stdout).slice(-1500));}
      const result=await this.dependencies(true);if(!result.ready)throw new Error('Capture tools are still unavailable after installation');return {...result,installing:false};
    })();
    try{return await this.installing;}finally{this.installing=undefined;}
  }
  async audio(id:string,stream:string,after:number,options:AudioOptions={}) {
    if(!Number.isInteger(after)||after<0 || stream.length>512)throw new Error('Invalid audio cursor or stream');
    const capture=await this.requireCapture(id);const live=['running','starting'].includes(capture.status);
    let entry=this.audioCaptures.get(id);
    if(!entry || Date.now()-entry.at>1500){
      if(this.audioCaptures.size>=4)this.audioCaptures.delete(this.audioCaptures.keys().next().value!);
      const promise=this.readAudioPackets(id,live);entry={at:Infinity,promise};this.audioCaptures.set(id,entry);
      const current=entry;void promise.then(()=>{if(this.audioCaptures.get(id)===current)current.at=Date.now();},()=>{if(this.audioCaptures.get(id)===current)this.audioCaptures.delete(id);});
    }
    let packets=await entry.promise;
    const target=(stream?packets.find(p=>streamKey(p)===stream):packets.find(p=>['PCMU','PCMA','AMR','AMR-WB','EVS'].includes(p.description?.codec??''))??packets[0]);
    let keySource=options.srtp?'manual':'none';let effectiveOptions=options;
    if(target && options.autoKey!==false){
      const id=streamKey(target);
      const ims=await this.imsAudio?.(target).catch(()=>undefined);
      if(ims?.description && (!target.description || target.description.codec.startsWith('PT '))){
        packets=packets.map(p=>streamKey(p)===id?{...p,streamId:id,description:ims.description}:p);
      }
      if(!options.srtp){
        const path=await this.pcap.getDownloadPath(capture.id);
        const sdp=await readAudioCapture(['-n','-r',path,'-Y','sdp','-T','pdml']);
        const candidates=[...sdesKeys(sdp.stdout,target).map(srtp=>({srtp,source:'captured SDP'})),...(ims?.keys??[]).map(srtp=>({srtp,source:'IMS SIP trace'}))];
        if(target.raw)for(const candidate of candidates){
          const decoder=new SrtpDecoder(candidate.srtp);
          try{decoder.decode(Buffer.from(target.raw,'hex'));effectiveOptions={...options,srtp:candidate.srtp};keySource=candidate.source;break;}catch{/* A key for another direction/session must never produce audio. */}finally{decoder.destroy();}
        }
      }
    }
    return {...await renderAudio(packets,stream || (target?streamKey(target):''),after,effectiveOptions,await codecTools()),live,keySource};
  }
  private async readAudioPackets(id:string,live:boolean){
    const path=await this.pcap.getDownloadPath(id);
    const base=['-n','-r',path,'--enable-heuristic','rtp_udp'];
    const [rtp,sdp]=await Promise.all([
      readAudioCapture([...base,'-Y','rtp && !icmp && !icmpv6','-T','fields',...['frame.number','frame.time_epoch','_ws.col.Source','_ws.col.Destination','udp.srcport','udp.dstport','rtp.ssrc','rtp.p_type','rtp.timestamp','rtp.payload','udp.payload','srtp.enc_payload'].flatMap(f=>['-e',f]),'-E','separator=\t','-E','occurrence=l']),
      readAudioCapture([...base,'-Y','sdp','-T','pdml']),
    ]);
    for(const result of [rtp,sdp])if(result.exitCode!==0 && !(live && /cut short in the middle|less data was read than was expected/i.test(result.stderr)))throw new Error('Unable to read RTP/SDP. Check the capture tools and file.');
    const mappings=parseSdp(sdp.stdout);
    return parseRtp(rtp.stdout).map(p=>({...p,description:resolveCodec(mappings,p)}));
  }
  async targets() {
    const [four,five,subscribers] = await Promise.all([this.active.getActive4GUEs(),this.active.getActive5GUEs(),this.subscribers.findAllFull()]);
    const byImsi = new Map(subscribers.map(sub=>[sub.imsi,sub]));
    const rows = new Map<string,{imsi:string;nickname?:string;radioIp?:string;state?:string;sessions:Array<{apn:string;ip:string}>}>();
    for (const ue of [...four,...five]) {
      if (!ue.imsi || ue.mmState === 'deregistered') continue;
      const previous = rows.get(ue.imsi);
      const sessions = [...(previous?.sessions ?? []),...(ue.sessions ?? [{apn:ue.apn ?? ue.dnn ?? '',ip:ue.ip}])].filter(s=>isIP(s.ip));
      rows.set(ue.imsi,{imsi:ue.imsi,nickname:byImsi.get(ue.imsi)?.nickname,radioIp:ue.radioIp,state:ue.cmState,
        sessions:sessions.filter((s,i,all)=>all.findIndex(t=>t.ip===s.ip && t.apn===s.apn)===i).map(s=>({...s,ip:canonicalIp(s.ip)}))});
    }
    return [...rows.values()].filter(row=>row.sessions.length);
  }
  async overview() {
    const [interfaces,targets,captures] = await Promise.all([this.pcap.listInterfaces(),this.targets(),this.pcap.listCaptures()]);
    return {interfaces,targets,captures:captures.filter(c=>!!c.ueDiagnostics).slice(0,50)};
  }
  async requireCapture(id:string):Promise<PcapManifest> {
    const capture=(await this.pcap.listCaptures()).find(c=>c.id===id && c.ueDiagnostics);
    if(!capture) throw new Error('UE diagnostic capture not found');
    return capture;
  }
  async start(input:{imsi?:string;addresses?:string[];interface?:string;durationSeconds?:number;sizeMb?:number}) {
    if(this.starting) throw new Error('A diagnostic capture is already starting');
    this.starting=true;
    try {
      const imsi=String(input.imsi ?? '').trim();
      if(imsi && !/^\d{5,16}$/.test(imsi)) throw new Error('Invalid IMSI');
      const target=imsi ? (await this.targets()).find(t=>t.imsi===imsi) : undefined;
      if(imsi && !target) throw new Error('The selected UE no longer has an active IP session');
      const addresses=captureAddresses(input.addresses?.length ? input.addresses : target?.sessions.map(s=>s.ip));
      if(target && addresses.some(ip=>!target.sessions.some(s=>s.ip===ip))) throw new Error('The selected address does not belong to this UE');
      const interfaces=await this.pcap.listInterfaces();
      const requestedInterface=String(input.interface ?? 'auto');
      let captureInterfaces:string[];
      if(requestedInterface==='auto') {
        const routes=await Promise.all(addresses.map(async ip=>{
          const route=await this.executor.executeLocalCommand('ip',['-j','route','get',ip],5000);
          try { return String(JSON.parse(route.stdout)[0]?.dev ?? ''); } catch { return ''; }
        }));
        if(routes.some(iface=>!iface)) throw new Error('No route to a UE IP. Choose a capture interface explicitly.');
        captureInterfaces=[...new Set(routes)];
      } else captureInterfaces=[requestedInterface];
      if(captureInterfaces.some(iface=>iface!=='any' && !interfaces.some(i=>i.name===iface))) throw new Error('Unknown capture interface');
      const duration=Number(input.durationSeconds ?? 60),size=Number(input.sizeMb ?? 10);
      if(!Number.isInteger(duration)||duration<5||duration>3600) throw new Error('Duration must be between 5 and 3600 seconds');
      if(!Number.isInteger(size)||size<1||size>50) throw new Error('File limit must be between 1 and 50 MB');
      const running=(await this.pcap.listCaptures()).filter(c=>c.ueDiagnostics && ['running','starting'].includes(c.status));
      if(running.length>=2) throw new Error('Stop a running diagnostic capture before starting another');
      return await this.pcap.start({interfaces:captureInterfaces,scope:{mode:'custom',customBpf:addresses.map(ip=>'host '+ip).join(' or ')},
        label:'UE Diagnostics · '+(imsi || addresses.join(', ')),autostopSeconds:duration,autostopFilesizeKb:size*1024,
        ueDiagnostics:{imsi:imsi||undefined,addresses}});
    } finally {this.starting=false;}
  }
  async stop(id:string) { await this.requireCapture(id); return this.pcap.stop(id); }
  async snapshot(id:string,filter:string) {
    if(filter.length>512) throw new Error('Display filter is too long');
    const key=id+'\n'+filter;const old=this.snapshots.get(key);
    if(old && Date.now()-old.at<2500) return old.promise;
    const promise=this.readSnapshot(id,filter);
    // Bound cache size even when an operator changes filters repeatedly.
    if(this.snapshots.size>=20)this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(key,{at:Infinity,promise});
    try{const result=await promise;const entry=this.snapshots.get(key);if(entry?.promise===promise)entry.at=Date.now();return result;}catch(error){this.snapshots.delete(key);throw error;}
  }
  private async readSnapshot(id:string,filter:string) {
    const capture=await this.requireCapture(id);
    const path=await this.pcap.getDownloadPath(id);
    const args=['-n','-r',path,'--enable-heuristic','rtp_udp','-d','tcp.port==7777,http2'];
    if(filter.trim())args.push('-Y',filter.trim());
    args.push('-T','fields','-e','frame.number','-e','frame.time_epoch','-e','_ws.col.Source','-e','_ws.col.Destination',
      '-e','_ws.col.Protocol','-e','frame.len','-e','tcp.srcport','-e','tcp.dstport','-e','udp.srcport','-e','udp.dstport','-e','_ws.col.Info',
      '-E','separator=\t','-E','occurrence=l');
    const result=await this.executor.executeLocalCommand('tshark',args,15000);
    const running=['running','starting'].includes(capture.status);
    const partial=running && /cut short in the middle|less data was read than was expected/i.test(result.stderr);
    if(result.exitCode!==0 && !partial) {
      const error=result.stderr.split('\n').filter(line=>!line.startsWith('Running as user')).join('\n').trim();
      throw new Error(error || 'Unable to decode this capture');
    }
    const packets=parseDiagnosticPackets(result.stdout,capture.ueDiagnostics!.addresses);
    return {capture,live:running,partial,...diagnosticSummary(packets,running)};
  }
}
