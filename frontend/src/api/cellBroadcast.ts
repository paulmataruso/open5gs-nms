import axios from 'axios';
const client=axios.create({baseURL:`${import.meta.env.VITE_API_URL||''}/api/cell-broadcast`,withCredentials:true,timeout:60000});
export interface Tai {plmn:string;tac:number;}
export interface CbcZone {id:string;name:string;areas:Tai[];}
export interface CbcRadio {id:number;name:string;connected:boolean;areas:Tai[];}
export interface CbcMessage {id:string;message_id:number;serial:number;text:string;areas:string;status:string;detail:string;created_at:number;}
export interface CbcState {service:string;targeting:boolean;mmeSupported:boolean;radios:CbcRadio[];inventoryError:string|null;zones:CbcZone[];messages:CbcMessage[];tokens:Array<{id:string;name:string;zoneIds:string[];revoked:boolean}>;installation:{id:string;status:string;detail:string}|null;}
export const cellBroadcastApi={
  overview:()=>client.get<CbcState>('/overview').then(r=>r.data),
  saveZone:(zone:{name:string;areas:Tai[]},id?:string)=>(id?client.put(`/zones/${id}`,zone):client.post('/zones',zone)).then(r=>r.data),
  removeZone:(id:string)=>client.delete(`/zones/${id}`),
  install:()=>client.post('/install',{confirm:true}),
  service:(action:string)=>client.post(`/service/${action}`),
  send:(message:unknown)=>client.post('/messages',message).then(r=>r.data),
  stop:(id:string)=>client.post(`/messages/${id}/stop`).then(r=>r.data),
  createKey:(name:string,zoneIds:string[])=>client.post<{id:string;secret:string}>('/keys',{name,zoneIds}).then(r=>r.data),
  revokeKey:(id:string)=>client.delete(`/keys/${id}`),
};
