import axios from 'axios';
const http = axios.create({ baseURL: `${import.meta.env.VITE_API_URL || ''}/api/high-availability`, withCredentials: true, timeout: 60000 });
export interface HaNode { id: string; name: string; mmeUrl: string; smfUrl?: string; sshHost?: string; sshUser: string; }
export interface HaRadio { id: number; name: string; reportedName: string; ip: string; sctpPeer: string; plmn: string; areas: Array<{ tac: string; plmn: string }>; connected: boolean; connectedUes: number | null; }
export interface HaUe { imsi: string; cmState: string; mmState: string; radioId?: number; radioName: string; radioIp: string; sessions: Array<{ apn: string; ip: string }>; pdns: unknown[]; }
export interface HaSnapshot { node: HaNode; available: boolean; error?: string; radios: HaRadio[]; ues: HaUe[]; anchorBindings: Array<{ imsi: string; apn: string; ip: string }>; sessionDataAvailable: boolean; control: { available: boolean; pdnBindings: boolean; identity: {plmn:string;mme_gid:number;mme_code:number}|null;relativeCapacity:number|null; reason: string }; sampledAt: string; }
export interface HaJob { id: string; imsi: string; source: string; target: string; createdAt: number; status: string; detail: string; }
export interface HaOverview { nodes: HaSnapshot[]; jobs: HaJob[]; }
export const highAvailabilityApi = {
  overview: () => http.get<HaOverview>('/overview').then(r => r.data),
  addNode: (node: Omit<HaNode,'id'>) => http.post<HaNode>('/nodes',node).then(r => r.data),
  removeNode: (id: string) => http.delete(`/nodes/${encodeURIComponent(id)}`),
  relocate: (imsi: string, source: string, target: string) => http.post<HaJob>('/relocations',{imsi,source,target}).then(r => r.data),
};
