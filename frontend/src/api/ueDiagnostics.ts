import axios from 'axios';
import type { HostInterface, PcapManifest } from './pcap';
const api=axios.create({baseURL:'/api/ue-diagnostics',withCredentials:true});
export interface DiagnosticTarget {imsi:string;nickname?:string;radioIp?:string;state?:string;sessions:Array<{apn:string;ip:string}>}
export interface DiagnosticPacket {frameNumber:number;timeEpoch:number;src:string;dst:string;srcPort:string;dstPort:string;protocol:string;length:number;info:string;direction:'tx'|'rx'|'other'}
export interface DiagnosticFlow {src:string;dst:string;srcPort:string;dstPort:string;protocol:string;direction:string;packets:number;bytes:number;bps:number;pps:number}
export interface DiagnosticSnapshot {capture:PcapManifest;live:boolean;partial:boolean;totalPackets:number;totalBytes:number;windowSeconds:number;txBps:number;rxBps:number;flows:DiagnosticFlow[];packets:DiagnosticPacket[];truncated:boolean}
export interface DiagnosticDependencies {tshark:boolean;dumpcap:boolean;ready:boolean;installing:boolean;audioCodecs:string[];ffmpeg:boolean;amr:boolean;amrWb:boolean;evs:boolean;srtpSuites:string[]}
export interface AudioSnapshot {streams:Array<{id:string;src:string;dst:string;srcPort:string;dstPort:string;ssrc:string;codec:string;supported:boolean;packets:number;reason?:string;encrypted:boolean;fmtp:string;clock:number}>;selected:string;cursor:number;sampleRate:number;pcm:string;seconds:number;skipped:boolean;live:boolean;notice:string;keySource:string}
export interface AudioOptions {autoKey:boolean;codec:'auto'|'PCMU'|'PCMA'|'AMR'|'AMR-WB'|'EVS';octetAlign:'auto'|'0'|'1';hfOnly:'auto'|'0'|'1';srtp?:{key:string;suite:'AES_CM_128_HMAC_SHA1_80'|'AES_CM_128_HMAC_SHA1_32';roc:number}}
export const ueDiagnosticsApi={
 dependencies:()=>api.get<DiagnosticDependencies>('/dependencies').then(r=>r.data),
 install:()=>api.post<DiagnosticDependencies>('/dependencies/install',{}, {timeout:900000}).then(r=>r.data),
 audio:(id:string,stream:string,after:number,options:AudioOptions)=>api.post<AudioSnapshot>('/captures/'+id+'/audio',{stream,after,...options},{timeout:45000}).then(r=>r.data),
 overview:()=>api.get<{interfaces:HostInterface[];targets:DiagnosticTarget[];captures:PcapManifest[]}>('/overview').then(r=>r.data),
 start:(input:{imsi?:string;addresses?:string[];interface:string;durationSeconds:number;sizeMb:number})=>api.post<{capture:PcapManifest}>('/start',input).then(r=>r.data.capture),
 stop:(id:string)=>api.post<{capture:PcapManifest}>('/captures/'+id+'/stop').then(r=>r.data.capture),
 snapshot:(id:string,filter:string)=>api.get<DiagnosticSnapshot>('/captures/'+id+'/live',{params:{filter},timeout:25000}).then(r=>r.data),
};
