import axios from 'axios';

const api = axios.create({ baseURL: '/api/pcap', withCredentials: true });

export interface HostInterface {
  name: string;
  ip: string;
  prefix: number;
  state: 'up' | 'down';
}

export type PcapGroup = '4G' | '5G' | 'IMS' | 'VoWiFi' | 'SMS' | 'Infra';

export interface PcapHostPort {
  proto: 'tcp' | 'udp' | 'sctp';
  addr: string;
  port: number;
  role: string;
}

export interface NfCaptureDescriptor {
  nf: string;
  label: string;
  group: PcapGroup;
  hostPorts: PcapHostPort[];
}

export type CaptureScopeMode = 'all' | 'nf' | 'functionType' | 'gtpAll' | 'custom';

export interface CaptureScopeInput {
  mode: CaptureScopeMode;
  nfs?: string[];
  functionType?: string;
  customBpf?: string;
}

export type CaptureStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface PcapManifest {
  id: string;
  label: string;
  createdAt: string;
  interfaces: string[];
  scopeMode: CaptureScopeMode;
  scopeDescription: string;
  bpf: string;
  unitName: string;
  status: CaptureStatus;
  startedAt: string;
  stoppedAt?: string;
  sizeBytes?: number;
  error?: string;
}

export interface DecodePreset {
  id: string;
  label: string;
  filter: string;
}

export interface PacketRow {
  frameNumber: number;
  timeEpoch: number;
  src: string;
  dst: string;
  protocol: string;
  length: number;
  info: string;
}

export interface PacketTreeNode {
  name: string;
  label: string;
  children: PacketTreeNode[];
}

export const pcapApi = {
  listInterfaces: async (): Promise<HostInterface[]> => {
    const { data } = await api.get('/interfaces');
    return data.interfaces;
  },
  listNfs: async (): Promise<NfCaptureDescriptor[]> => {
    const { data } = await api.get('/nfs');
    return data.nfs;
  },
  listPresets: async (): Promise<DecodePreset[]> => {
    const { data } = await api.get('/presets');
    return data.presets;
  },
  listCaptures: async (): Promise<PcapManifest[]> => {
    const { data } = await api.get('/captures');
    return data.captures;
  },
  start: async (input: { interfaces: string[]; scope: CaptureScopeInput; label?: string }): Promise<PcapManifest> => {
    const { data } = await api.post('/start', input);
    return data.capture;
  },
  stop: async (id: string): Promise<PcapManifest> => {
    const { data } = await api.post(`/stop/${id}`);
    return data.capture;
  },
  getSummary: async (id: string): Promise<string> => {
    const { data } = await api.get(`/captures/${id}/summary`);
    return data.summary;
  },
  getPackets: async (id: string, filter: string): Promise<{ rows: PacketRow[]; truncated: boolean }> => {
    const { data } = await api.get(`/captures/${id}/packets`, { params: { filter } });
    return { rows: data.rows, truncated: data.truncated };
  },
  getPacketDetail: async (id: string, frameNumber: number): Promise<{ tree: PacketTreeNode[]; hex: string }> => {
    const { data } = await api.get(`/captures/${id}/packets/${frameNumber}`);
    return { tree: data.tree, hex: data.hex };
  },
  downloadUrl: (id: string): string => `/api/pcap/captures/${id}/download`,
  delete: async (id: string): Promise<void> => {
    await api.delete(`/captures/${id}`);
  },
};
