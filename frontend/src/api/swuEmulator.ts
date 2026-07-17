import axios from 'axios';

const api = axios.create({ baseURL: '/api/swu-emulator', withCredentials: true });

export interface SwuEmulatorStatus {
  success: boolean;
  installed: boolean;
  epdgIp: string | null;
  tunnelEstablished: boolean;
  assignedIp: string | null;
  running: boolean;
  imsi: string | null;
  k: string | null;
  opc: string | null;
  staticIp: string | null;
  autoCreatedSubscriber: boolean;
  startedAt: string | null;
}

export interface SwuRunInput {
  imsi?: string;
  k?: string;
  opc?: string;
  staticIp?: string;
}

export const swuEmulatorApi = {
  getStatus: async (): Promise<SwuEmulatorStatus> => { const { data } = await api.get('/status'); return data; },
  install: () => fetch('/api/swu-emulator/install', { method: 'POST', credentials: 'include' }),
  getLog: async (): Promise<string> => { const { data } = await api.get('/log', { responseType: 'text' }); return data; },
  streamLog: () => fetch('/api/swu-emulator/log/stream', { credentials: 'include' }),
  run: async (input: SwuRunInput) => { const { data } = await api.post('/run', input); return data; },
  stop: async () => { const { data } = await api.post('/stop'); return data; },
};
